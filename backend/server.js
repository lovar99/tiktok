const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { TikTokLiveConnection } = require("tiktok-live-connector");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "tiktok_super_secret_key_2024_secure";
const port = process.env.PORT || 4000;

// Active site visitors tracking (Admin panel tracking)
let activeSiteVisitors = {};

// --- GLOBAL STREAM STATE ---
let tiktokLiveConnection = null;
let currentTrackedUsername = null;
let streamStats = {};
let streamComments = [];
let streamLeaderboard = null;
let pollKeywords = [];
let pollCounts = {};
let streamWatchdog = null;
let streamLastActivity = Date.now();

// CLOUDFLARE D1 DATABASE CONFIGURATION
const D1_API_URL = "https://api.cloudflare.com/client/v4/accounts/680373c66f54cff8c03c582df23f66f9/d1/database/c989670d-f06b-4ca0-9f5e-473d2ff655f4/query";
const D1_API_TOKEN = "vRih21q219dK3Z48H8g6D2pSGB27-E8S2e8TqT_o";

async function queryD1(sql, params = []) {
    try {
        const response = await fetch(D1_API_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${D1_API_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ sql, params })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.errors?.[0]?.message || "D1 Error");
        return data;
    } catch (error) {
        console.error("D1 Query Error:", error);
        return { success: false, error };
    }
}

// --- AUTHENTICATION API ---
app.post("/api/auth", async (req, res) => {
    const { action, username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "تکایە هەموو زانیارییەکان پڕبکەرەوە." });

    if (action === 'signup') {
        const hash = await bcrypt.hash(password, 10);
        const result = await queryD1(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, [username, hash, 'user']);
        
        if (!result.success) return res.status(400).json({ error: "ئەم ناوە پێشتر بەکارهاتووە." });
        
        const token = jwt.sign({ username, role: 'user' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ message: "✅ هەژمارەکەت دروستکرا!", token });
    } else {
        const result = await queryD1(`SELECT * FROM users WHERE username = ?`, [username]);
        const user = result.result?.[0]?.results?.[0];

        if (!user) return res.status(401).json({ error: "ناوی بەکارهێنەر هەڵەیە." });

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: "وشەی نهێنی هەڵەیە." });

        await queryD1(`INSERT INTO analytics (ip_address) VALUES (?)`, [req.headers['x-forwarded-for'] || req.socket.remoteAddress]);
        await queryD1(`INSERT INTO login_history (user_id) VALUES (?)`, [user.id]);

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ message: "✅ چوونە ژوورەوە سەرکەوتوو بوو!", token });
    }
});

// Helper to auto-save stream
async function saveStreamToD1(username, stats) {
    if (!username || Object.keys(stats).length === 0) return;
    try {
        const sessionData = JSON.stringify(stats);
        await queryD1(`INSERT INTO sessions (username, session_data) VALUES (?, ?)`, [username, sessionData]);
        console.log(`Auto-saved session for @${username}`);
        io.emit("streamStatus", { status: "success", message: "✅ دانیشتنەکە پاشەکەوت کرا لە بنکەی دراوە! (Saved to DB)" });
    } catch (e) {
        console.error("Failed to auto-save stream", e);
    }
}

function emitPollUpdate() {
    const sorted = Object.keys(pollCounts)
        .sort((a, b) => pollCounts[b] - pollCounts[a])
        .slice(0, 3)
        .map(k => ({ keyword: k, count: pollCounts[k] }));
    io.emit("pollUpdate", sorted);
}

function getUser(data) {
    const uid = data.uniqueId;
    if (!streamStats[uid]) {
        streamStats[uid] = { 
            uid: uid, 
            name: data.nickname || "Unknown", 
            avatar: data.profilePictureUrl || "https://www.tiktok.com/favicon.ico", 
            commentCount: 0, 
            likeCount: 0, 
            actualTotalLikes: 0, 
            giftCount: 0, 
            shareCount: 0 
        };
    }
    return streamStats[uid];
}

function emitUpdate() {
    streamLastActivity = Date.now();
    const activeUsersCount = Object.keys(streamStats).length;
    const sortedUsers = Object.values(streamStats)
        .sort((a, b) => (b.giftCount * 1000 + b.commentCount * 10 + b.actualTotalLikes) - (a.giftCount * 1000 + a.commentCount * 10 + a.actualTotalLikes))
        .slice(0, 100);
    
    streamLeaderboard = { totalUniqueUsers: activeUsersCount, topUsers: sortedUsers };
    io.emit("leaderboardUpdate", streamLeaderboard);
}

// --- SOCKET.IO LIVE TRACKING LOGIC ---
io.on("connection", (socket) => {
    activeSiteVisitors[socket.id] = { connectedAt: new Date().toISOString() };

    socket.on("setPollKeywords", (keywords) => {
        pollKeywords = keywords.map(k => String(k).trim().toLowerCase());
        pollKeywords.forEach(k => {
            if (pollCounts[k] === undefined) pollCounts[k] = 0;
        });
        emitPollUpdate();
    });

    socket.on("getAllUsers", () => {
        if (tiktokLiveConnection) {
            socket.emit("allUsersData", Object.values(streamStats));
        }
    });

    socket.on("requestInitialState", async (adminUser) => {
        const syncData = {
            allComments: [],
            leaderboard: null,
            isActive: false,
            currentTrackedUsername: null,
            pollKeywords: [],
            pollCounts: {}
        };
        
        if (tiktokLiveConnection) {
            syncData.isActive = true;
            syncData.allComments = streamComments;
            syncData.leaderboard = streamLeaderboard;
            syncData.currentTrackedUsername = currentTrackedUsername;
            syncData.pollKeywords = pollKeywords;
            syncData.pollCounts = pollCounts;
        }

        if (adminUser && adminUser !== "unknown") {
            const res = await queryD1(`SELECT settings_data FROM user_settings WHERE username = ?`, [adminUser]);
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
            widgetState: data.widgetState,
            activeStreamTarget: data.activeStreamTarget // Keep for legacy client support
        });
        
        await queryD1(`
            INSERT INTO user_settings (username, settings_data) 
            VALUES (?, ?) 
            ON CONFLICT(username) DO UPDATE SET settings_data = excluded.settings_data
        `, [data.username, settingsJson]);
    });

    socket.on("saveSessionToD1", async (username) => {
        if (tiktokLiveConnection && currentTrackedUsername === username) {
            await saveStreamToD1(username, streamStats);
        }
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
                const hash = await bcrypt.hash(newPass, 10);
                await queryD1(`UPDATE users SET username = ?, password_hash = ? WHERE id = ?`, [newName, hash, uid]);
            } else {
                await queryD1(`UPDATE users SET username = ? WHERE id = ?`, [newName, uid]);
            }
            socket.emit("adminRefresh");
        } catch (e) { console.error("Failed to edit user", e); }
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
        if (!tiktokLiveConnection) return;
        
        saveStreamToD1(currentTrackedUsername, streamStats); // Auto-save!
        try { tiktokLiveConnection.disconnect(); } catch(e) {}
        
        if (streamWatchdog) clearInterval(streamWatchdog);
        
        tiktokLiveConnection = null;
        currentTrackedUsername = null;
        streamStats = {};
        streamComments = [];
        streamLeaderboard = null;
        pollKeywords = [];
        pollCounts = {};
    });

    socket.on("startStream", (username) => {
        if (tiktokLiveConnection && currentTrackedUsername === username) {
            // Stream already running! Just notify the client it's good.
            socket.emit("streamStatus", { status: "success", message: `✅ پەیوەست بوو بە ستریمی چالاک: @${username}` });
            return;
        }

        // If a different stream is running, stop it first
        if (tiktokLiveConnection) {
            saveStreamToD1(currentTrackedUsername, streamStats);
            try { tiktokLiveConnection.disconnect(); } catch(e) {}
            if (streamWatchdog) clearInterval(streamWatchdog);
        }

        // Initialize a new global stream
        currentTrackedUsername = username;
        streamStats = {};
        streamComments = [];
        streamLeaderboard = null;
        pollKeywords = [];
        pollCounts = {};
        streamLastActivity = Date.now();

        tiktokLiveConnection = new TikTokLiveConnection(username, {});

        // Watchdog to prevent silent freezing
        streamWatchdog = setInterval(() => {
            if (Date.now() - streamLastActivity > 45000) {
                console.log(`Watchdog timeout for @${currentTrackedUsername}. Disconnecting.`);
                io.emit("streamStatus", { status: "error", message: `⚠️ ستریمەکە وەستا بەهۆی نەبوونی داتا! تکایە دووبارە دەستپێبکە.` });
                saveStreamToD1(currentTrackedUsername, streamStats);
                try { tiktokLiveConnection.disconnect(); } catch(e) {}
                clearInterval(streamWatchdog);
                tiktokLiveConnection = null;
                currentTrackedUsername = null;
            }
        }, 10000);

        tiktokLiveConnection.connect().then(() => {
            io.emit("streamStatus", { status: "success", message: `✅ سەرکەوتوو بوو! پەیوەست بوو بە @${username}` });
        }).catch(err => {
            io.emit("streamStatus", { status: "error", message: `❌ نەتوانرا پەیوەندی بکرێت بە @${username}` });
            if (streamWatchdog) clearInterval(streamWatchdog);
            tiktokLiveConnection = null;
            currentTrackedUsername = null;
        });

        tiktokLiveConnection.on('roomUser', data => { streamLastActivity = Date.now(); if (data.viewerCount !== undefined) io.emit("viewerUpdate", { count: data.viewerCount }); });
        tiktokLiveConnection.on('room', data => { streamLastActivity = Date.now(); if (data.viewerCount !== undefined) io.emit("viewerUpdate", { count: data.viewerCount }); });
        
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
            
            streamComments.push(commentData);
            if(streamComments.length > 500) streamComments.shift();
            
            io.emit("newComment", commentData);
            emitUpdate();
        });

        tiktokLiveConnection.on('like', data => {
            const user = getUser(data);
            user.likeCount += (data.likeCount || 1); 
            user.actualTotalLikes = user.likeCount;
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

        tiktokLiveConnection.on('streamEnd', () => {
            io.emit("streamStatus", { status: "error", message: `🛑 ستریمەکە کۆتایی هات!` });
            saveStreamToD1(currentTrackedUsername, streamStats); // Auto-save!
            if (streamWatchdog) clearInterval(streamWatchdog);
            tiktokLiveConnection = null;
            currentTrackedUsername = null;
        });

        tiktokLiveConnection.on('disconnected', () => {
            console.log("Stream disconnected, attempting reconnect for @", username);
            tiktokLiveConnection.connect().catch(e => {
                io.emit("streamStatus", { status: "error", message: `⚠️ پەیوەندی بە ستریمەکەوە پچڕا (Disconnected)` });
                saveStreamToD1(currentTrackedUsername, streamStats); // Auto-save!
                if (streamWatchdog) clearInterval(streamWatchdog);
                tiktokLiveConnection = null;
                currentTrackedUsername = null;
            });
        });

        tiktokLiveConnection.on('error', err => {
            console.error('TikTok Live Error for', username, ':', err);
            io.emit("streamStatus", { status: "error", message: `❌ هەڵەیەک ڕوویدا لە پەیوەندیکردن!` });
            saveStreamToD1(currentTrackedUsername, streamStats); // Auto-save!
            if (streamWatchdog) clearInterval(streamWatchdog);
            tiktokLiveConnection = null;
            currentTrackedUsername = null;
        });
    });

    socket.on("disconnect", () => {
        delete activeSiteVisitors[socket.id];
        // The stream keeps running globally until manually stopped or ended.
    });
});

server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});