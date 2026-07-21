const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { TikTokLiveConnection } = require('tiktok-live-connector');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const port = process.env.PORT || 3000;
const io = new Server(server, { cors: { origin: "*" } });

// Cloudflare D1 Configuration (Loaded from Render Environment Variables)
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_D1_ID = process.env.CF_D1_ID; 
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-tiktok-key-change-me";

// Active live users (Admin panel tracking)
let activeSiteVisitors = {};

// Memory cache for active cross-device streams
let globalActiveComments = [];
let globalActiveLeaderboard = null;

// --- CLOUDFLARE D1 HELPER FUNCTION ---
async function queryD1(sql, params = []) {
    if (!CF_ACCOUNT_ID || !CF_D1_ID || !CF_API_TOKEN) {
        console.error("Missing Cloudflare Credentials in Environment Variables!");
        return { success: false, error: "Database not configured on server." };
    }
    
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_ID}/query`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CF_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sql, params })
        });
        const data = await response.json();
        return data;
    } catch (err) {
        console.error("D1 Error:", err);
        return { success: false, error: err.message };
    }
}

// --- AUTHENTICATION API (LOGIN / SIGNUP) ---
app.post('/api/auth', async (req, res) => {
    const { action, username, password } = req.body;
    
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });

    if (action === 'signup') {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = `INSERT INTO users (username, password_hash) VALUES (?, ?)`;
        const result = await queryD1(sql, [username, hashedPassword]);
        
        if (result.success === false || (result.errors && result.errors.length > 0)) {
            return res.status(400).json({ error: "Username might already exist." });
        }
        res.json({ message: "✅ هەژمارەکەت دروستکرا! ئێستا دەتوانیت بچیتە ژوورەوە." });
    } 
    else if (action === 'login') {
        const sql = `SELECT * FROM users WHERE username = ?`;
        const result = await queryD1(sql, [username]);
        
        const rows = result.result?.[0]?.results;
        if (!rows || rows.length === 0) return res.status(401).json({ error: "هەژمار نەدۆزرایەوە." });

        const user = rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: "وشەی نهێنی هەڵەیە." });

        // Log the visit in analytics
        await queryD1(`INSERT INTO analytics (ip_address) VALUES (?)`, [req.headers['x-forwarded-for'] || req.socket.remoteAddress]);
        await queryD1(`INSERT INTO login_history (user_id) VALUES (?)`, [user.id]);

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ message: "✅ چوونە ژوورەوە سەرکەوتوو بوو!", token });
    }
});

// --- SOCKET.IO LIVE TRACKING LOGIC ---
io.on("connection", (socket) => {
    activeSiteVisitors[socket.id] = { connectedAt: new Date().toISOString() };
    
    let userStats = {}; 
    let tiktokLiveConnection = null;
    let pollKeywords = [];
    let pollCounts = {};

    socket.on("setPollKeywords", (keywords) => {
        pollKeywords = keywords.map(k => String(k).trim().toLowerCase());
        pollKeywords.forEach(k => {
            if (pollCounts[k] === undefined) pollCounts[k] = 0;
        });
        emitPollUpdate();
    });

    function emitPollUpdate() {
        const sorted = Object.keys(pollCounts)
            .sort((a, b) => pollCounts[b] - pollCounts[a])
            .slice(0, 3)
            .map(k => ({ keyword: k, count: pollCounts[k] }));
        socket.emit("pollUpdate", sorted);
    }

    function getUser(data) {
        const u = data.user || data.userDetails || data || {};
        const rawId = u.displayId || u.uniqueId || data.displayId || data.uniqueId || u.userId || data.userId || "unknown";
        const nickname = u.nickname || u.displayName || data.nickname || data.displayName || "Anonymous";
        const safeKey = `${nickname}_${rawId}`;
        let profilePic = data.profilePictureUrl;
        if (!profilePic && u.avatarThumb && u.avatarThumb.urlList) profilePic = u.avatarThumb.urlList[0];
        if (!profilePic) profilePic = "https://www.tiktok.com/favicon.ico";
        if (!userStats[safeKey]) {
            const timeObj = new Date();
            const timeStr = String(timeObj.getHours()).padStart(2, '0') + ":" + String(timeObj.getMinutes()).padStart(2, '0');
            userStats[safeKey] = { uniqueId: rawId, nickname, profilePictureUrl: profilePic, commentCount: 0, likeCount: 0, actualTotalLikes: 0, giftCount: 0, shareCount: 0, firstSeen: timeStr };
        }
        return userStats[safeKey];
    }

    function emitUpdate() {
        const topComments = Object.values(userStats).sort((a, b) => b.commentCount - a.commentCount).slice(0, 30);
        const topLikes = Object.values(userStats).sort((a, b) => b.likeCount - a.likeCount).slice(0, 30);
        const topGifts = Object.values(userStats).sort((a, b) => b.giftCount - a.giftCount).slice(0, 30);
        const topShares = Object.values(userStats).sort((a, b) => b.shareCount - a.shareCount).slice(0, 30);
        
        globalActiveLeaderboard = { topComments, topLikes, topGifts, topShares, totalUniqueUsers: Object.keys(userStats).length };
        io.emit('leaderboardUpdate', globalActiveLeaderboard); 
    }

    socket.on("getAllUsers", () => socket.emit("allUsersData", Object.values(userStats)));

    socket.on("requestInitialState", async (username) => {
        const syncData = {
            allComments: globalActiveComments,
            leaderboard: globalActiveLeaderboard
        };

        if (username && username !== "unknown") {
            const res = await queryD1(`SELECT settings_data FROM user_settings WHERE username = ?`, [username]);
            const row = res.result?.[0]?.results?.[0];
            if (row && row.settings_data) {
                try {
                    const settings = JSON.parse(row.settings_data);
                    syncData.searchHistory = settings.searchHistory;
                    syncData.widgetState = settings.widgetState;
                } catch(e) {}
            }
        }
        socket.emit("initialState", syncData);
    });

    socket.on("saveUserSettings", async (data) => {
        if (!data.username || data.username === "unknown") return;
        const settingsJson = JSON.stringify({
            searchHistory: data.searchHistory,
            widgetState: data.widgetState
        });
        
        await queryD1(`
            INSERT INTO user_settings (username, settings_data) 
            VALUES (?, ?) 
            ON CONFLICT(username) DO UPDATE SET settings_data = excluded.settings_data
        `, [data.username, settingsJson]);
    });

    // --- SESSION HISTORY & DATABASE ---
    socket.on("saveSessionToD1", async (username) => {
        if (!username || Object.keys(userStats).length === 0) return;
        const sessionData = JSON.stringify(userStats);
        await queryD1(`INSERT INTO sessions (username, session_data) VALUES (?, ?)`, [username, sessionData]);
        socket.emit("streamStatus", { status: "success", message: "✅ دانیشتنەکە پاشەکەوت کرا لە بنکەی دراوە! (Saved to DB)" });
    });

    socket.on("getPastSessions", async () => {
        const res = await queryD1(`SELECT id, username, start_time FROM sessions ORDER BY id DESC LIMIT 20`);
        socket.emit("pastSessionsData", res.result?.[0]?.results || []);
    });

    socket.on("loadPastSession", async (id) => {
        const res = await queryD1(`SELECT session_data FROM sessions WHERE id = ?`, [id]);
        const data = res.result?.[0]?.results?.[0]?.session_data;
        if(data) {
            socket.emit("pastSessionLoaded", JSON.parse(data));
        }
    });

    // --- SECRET ADMIN PANEL REQUEST ---
    socket.on("requestAdminPanel", async () => {
        const analyticsRes = await queryD1(`SELECT ip_address, visit_time FROM analytics ORDER BY id DESC LIMIT 100`);
        const loginsRes = await queryD1(`SELECT u.username, l.login_time, l.duration_minutes FROM login_history l JOIN users u ON l.user_id = u.id ORDER BY l.id DESC LIMIT 100`);
        const usersRes = await queryD1(`SELECT id, username, role, created_at FROM users`);
        
        // Map Database columns to generic names so the frontend/network tab never exposes the SQL schema
        const safeAnalytics = (analyticsRes.result?.[0]?.results || []).map(r => ({ ip: r.ip_address, time: r.visit_time }));
        const safeLogins = (loginsRes.result?.[0]?.results || []).map(r => ({ user: r.username, time: r.login_time, duration: r.duration_minutes }));
        const safeUsers = (usersRes.result?.[0]?.results || []).map(r => ({ uid: r.id, name: r.username, role: r.role, joined: r.created_at }));

        socket.emit("adminPanelData", {
            analytics: safeAnalytics,
            logins: safeLogins,
            users: safeUsers,
            activeCount: Object.keys(activeSiteVisitors).length
        });
    });
    
    socket.on("adminEditUser", async (data) => {
        const { uid, newName, newPass } = data;
        if (!uid || !newName) return;
        
        try {
            if (newPass && newPass.trim() !== "") {
                const hash = await bcrypt.hash(newPass, 10); // Securely hash manual override password
                await queryD1(`UPDATE users SET username = ?, password_hash = ? WHERE id = ?`, [newName, hash, uid]);
            } else {
                await queryD1(`UPDATE users SET username = ? WHERE id = ?`, [newName, uid]);
            }
            socket.emit("adminRefresh");
        } catch (e) {
            console.error("Failed to edit user", e);
        }
    });

    socket.on("adminDeleteUser", async (userId) => {
        await queryD1(`DELETE FROM users WHERE id = ?`, [userId]);
        socket.emit("adminRefresh");
    });

    socket.on("adminKickUser", (username) => {
        io.emit("forceLogout", username);
    });

    socket.on("adminAddUser", async (data) => {
        const hash = await bcrypt.hash(data.password, 10);
        await queryD1(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, [data.username, hash, 'user']);
        socket.emit("adminRefresh");
    });

    socket.on("stopStream", () => {
        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch(e) {}
            tiktokLiveConnection = null;
        }
    });

    socket.on("startStream", (username) => {
        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch(e) {}
            tiktokLiveConnection = null;
        }
        
        userStats = {};
        globalActiveComments = [];
        globalActiveLeaderboard = null;
        
        pollCounts = {};
        pollKeywords.forEach(k => pollCounts[k] = 0);
        emitPollUpdate();

        tiktokLiveConnection = new TikTokLiveConnection(username, {});
        
        tiktokLiveConnection.connect().then(() => {
            socket.emit("streamStatus", { status: "success", message: `✅ سەرکەوتوو بوو! پەیوەست بوو بە @${username}` });
        }).catch(err => {
            socket.emit("streamStatus", { status: "error", message: `❌ نەتوانرا پەیوەندی بکرێت بە @${username}` });
        });

        tiktokLiveConnection.on('roomUser', data => { if (data.viewerCount !== undefined) socket.emit("viewerUpdate", { count: data.viewerCount }); });
        tiktokLiveConnection.on('room', data => { if (data.viewerCount !== undefined) socket.emit("viewerUpdate", { count: data.viewerCount }); });
        
        tiktokLiveConnection.on('member', data => { getUser(data); emitUpdate(); });
        
        tiktokLiveConnection.on('chat', data => {
            const user = getUser(data);
            user.commentCount += 1;
            let chatText = data.content || data.comment || data.text || data.msg || "";
            if (!chatText || String(chatText).trim() === "") chatText = "💬 [Sent a Sticker or Emote]";
            
            const chatLower = String(chatText).toLowerCase();
            let matchedVote = false;
            pollKeywords.forEach(keyword => {
                if (chatLower.includes(keyword)) {
                    pollCounts[keyword] += 1;
                    matchedVote = true;
                }
            });
            if (matchedVote) emitPollUpdate();

            const commentData = { uniqueId: user.uniqueId, nickname: user.nickname, profilePictureUrl: user.profilePictureUrl, comment: String(chatText) };
            
            globalActiveComments.push(commentData);
            if(globalActiveComments.length > 500) globalActiveComments.shift();
            
            io.emit("newComment", commentData);
            emitUpdate();
        });

        tiktokLiveConnection.on('like', data => {
            const user = getUser(data);
            user.likeCount += (data.likeCount || 1); 
            user.actualTotalLikes = Math.max(user.likeCount, (data.totalLikeCount || 0));
            emitUpdate();
        });

        tiktokLiveConnection.on('gift', data => {
            const user = getUser(data);
            user.giftCount += data.diamondCount ? (data.diamondCount * (data.repeatCount || 1)) : 1;
            emitUpdate();
        });

        tiktokLiveConnection.on('share', data => {
            const user = getUser(data);
            user.shareCount += 1;
            emitUpdate();
        });
    });

    socket.on("disconnect", () => {
        delete activeSiteVisitors[socket.id];
        if (tiktokLiveConnection) tiktokLiveConnection.disconnect();
    });
});

server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});