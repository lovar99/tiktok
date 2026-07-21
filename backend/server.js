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

// Active live users (Admin panel tracking)
let activeSiteVisitors = {};

// Active streams map: key = tiktokUsername, value = stream state
// Structure: { connection, stats, comments, leaderboard, pollKeywords, pollCounts, timeout, connectedSockets: Set }
const activeStreams = new Map();

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
        io.to(username).emit("streamStatus", { status: "success", message: "✅ دانیشتنەکە پاشەکەوت کرا لە بنکەی دراوە! (Saved to DB)" });
    } catch (e) {
        console.error("Failed to auto-save stream", e);
    }
}

// --- SOCKET.IO LIVE TRACKING LOGIC ---
io.on("connection", (socket) => {
    activeSiteVisitors[socket.id] = { connectedAt: new Date().toISOString() };
    socket.activeStreamTarget = null; // Which stream is this socket watching?

    function getStream() {
        if (!socket.activeStreamTarget) return null;
        return activeStreams.get(socket.activeStreamTarget);
    }

    function emitPollUpdate(stream, target) {
        if (!stream) return;
        const sorted = Object.keys(stream.pollCounts)
            .sort((a, b) => stream.pollCounts[b] - stream.pollCounts[a])
            .slice(0, 3)
            .map(k => ({ keyword: k, count: stream.pollCounts[k] }));
        io.to(target).emit("pollUpdate", sorted);
    }

    function getUser(stream, data) {
        const uid = data.uniqueId;
        if (!stream.stats[uid]) {
            stream.stats[uid] = { 
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
        return stream.stats[uid];
    }

    function emitUpdate(stream, target) {
        if (!stream) return;
        stream.lastActivity = Date.now();
        const activeUsersCount = Object.keys(stream.stats).length;
        const sortedUsers = Object.values(stream.stats)
            .sort((a, b) => (b.giftCount * 1000 + b.commentCount * 10 + b.actualTotalLikes) - (a.giftCount * 1000 + a.commentCount * 10 + a.actualTotalLikes))
            .slice(0, 100);
        
        stream.leaderboard = { totalUniqueUsers: activeUsersCount, topUsers: sortedUsers };
        io.to(target).emit("leaderboardUpdate", stream.leaderboard);
    }

    socket.on("setPollKeywords", (keywords) => {
        const stream = getStream();
        if (!stream) return;
        stream.pollKeywords = keywords.map(k => String(k).trim().toLowerCase());
        stream.pollKeywords.forEach(k => {
            if (stream.pollCounts[k] === undefined) stream.pollCounts[k] = 0;
        });
        emitPollUpdate(stream, socket.activeStreamTarget);
    });

    socket.on("getAllUsers", () => {
        const stream = getStream();
        if (stream) socket.emit("allUsersData", Object.values(stream.stats));
    });

    socket.on("requestInitialState", async (adminUser, targetUser) => {
        if (targetUser && targetUser !== "unknown") {
            socket.activeStreamTarget = targetUser;
            socket.join(targetUser); // Connects them back to the live room so they get stream updates!
        }

        const syncData = {
            allComments: [],
            leaderboard: null,
            isActive: false,
            activeStreamTarget: targetUser && targetUser !== "unknown" ? targetUser : null
        };
        
        const stream = getStream();
        if (stream) {
            syncData.isActive = true;
            syncData.allComments = stream.comments;
            syncData.leaderboard = stream.leaderboard;
            stream.connectedSockets.add(socket.id); // FIX: Ensure socket is tracked so it doesn't get cleaned up
        }

        if (adminUser && adminUser !== "unknown") {
            const res = await queryD1(`SELECT settings_data FROM user_settings WHERE username = ?`, [adminUser]);
            const row = res.result?.[0]?.results?.[0];
            if (row && row.settings_data) {
                try {
                    const settings = JSON.parse(row.settings_data);
                    syncData.searchHistory = settings.searchHistory;
                    syncData.widgetState = settings.widgetState;
                    
                    if (!targetUser && settings.activeStreamTarget) {
                        targetUser = settings.activeStreamTarget;
                        socket.activeStreamTarget = targetUser;
                        socket.join(targetUser); // Join the room recovered from DB!
                        syncData.activeStreamTarget = targetUser; // Send back to client
                        
                        const recoveredStream = activeStreams.get(targetUser);
                        if (recoveredStream) {
                            syncData.isActive = true;
                            syncData.allComments = recoveredStream.comments;
                            syncData.leaderboard = recoveredStream.leaderboard;
                        }
                    }
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
            activeStreamTarget: data.activeStreamTarget
        });
        
        await queryD1(`
            INSERT INTO user_settings (username, settings_data) 
            VALUES (?, ?) 
            ON CONFLICT(username) DO UPDATE SET settings_data = excluded.settings_data
        `, [data.username, settingsJson]);
    });

    socket.on("saveSessionToD1", async (username) => {
        const stream = activeStreams.get(username);
        if (!stream) return;
        await saveStreamToD1(username, stream.stats);
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
        const username = socket.activeStreamTarget;
        if (!username) return;
        
        const stream = activeStreams.get(username);
        if (stream) {
            saveStreamToD1(username, stream.stats); // Auto-save!
            if (stream.connection) {
                try { stream.connection.disconnect(); } catch(e) {}
            }
            if (stream.timeout) clearTimeout(stream.timeout);
            if (stream.watchdog) clearInterval(stream.watchdog);
            activeStreams.delete(username);
        }
        socket.leave(username);
        socket.activeStreamTarget = null;
    });

    socket.on("setUniqueId", (username) => {
        // Just join the room silently to resume events if refreshing
        socket.join(username);
        socket.activeStreamTarget = username;
        
        const stream = activeStreams.get(username);
        if (stream) {
            stream.connectedSockets.add(socket.id);
            if (stream.timeout) {
                clearTimeout(stream.timeout);
                stream.timeout = null;
            }
            socket.emit("streamStatus", { status: "success", message: `✅ دەستپێکردنەوە سەرکەوتوو بوو! @${username}` });
        }
    });

    socket.on("startStream", (username) => {
        if (socket.activeStreamTarget && socket.activeStreamTarget !== username) {
            socket.leave(socket.activeStreamTarget);
        }

        socket.join(username);
        socket.activeStreamTarget = username;

        let stream = activeStreams.get(username);
        if (stream) {
            // Stream already running! Just join it.
            stream.connectedSockets.add(socket.id);
            if (stream.timeout) {
                clearTimeout(stream.timeout);
                stream.timeout = null;
            }
            socket.emit("streamStatus", { status: "success", message: `✅ پەیوەست بوو بە ستریمی چالاک: @${username}` });
            return;
        }

        // Initialize a new stream
        stream = {
            connection: new TikTokLiveConnection(username, {}),
            stats: {},
            comments: [],
            leaderboard: null,
            pollKeywords: [],
            pollCounts: {},
            timeout: null,
            connectedSockets: new Set([socket.id]),
            lastActivity: Date.now()
        };
        activeStreams.set(username, stream);

        // Watchdog to prevent silent freezing
        stream.watchdog = setInterval(() => {
            if (Date.now() - stream.lastActivity > 45000) {
                console.log(`Watchdog timeout for @${username}. Disconnecting.`);
                io.to(username).emit("streamStatus", { status: "error", message: `⚠️ ستریمەکە وەستا بەهۆی نەبوونی داتا! تکایە دووبارە دەستپێبکە.` });
                saveStreamToD1(username, stream.stats);
                try { stream.connection.disconnect(); } catch(e) {}
                clearInterval(stream.watchdog);
                activeStreams.delete(username);
            }
        }, 10000);

        stream.connection.connect().then(() => {
            io.to(username).emit("streamStatus", { status: "success", message: `✅ سەرکەوتوو بوو! پەیوەست بوو بە @${username}` });
        }).catch(err => {
            io.to(username).emit("streamStatus", { status: "error", message: `❌ نەتوانرا پەیوەندی بکرێت بە @${username}` });
            if (stream.watchdog) clearInterval(stream.watchdog);
            activeStreams.delete(username);
        });

        stream.connection.on('roomUser', data => { stream.lastActivity = Date.now(); if (data.viewerCount !== undefined) io.to(username).emit("viewerUpdate", { count: data.viewerCount }); });
        stream.connection.on('room', data => { stream.lastActivity = Date.now(); if (data.viewerCount !== undefined) io.to(username).emit("viewerUpdate", { count: data.viewerCount }); });
        
        stream.connection.on('member', data => { getUser(stream, data); emitUpdate(stream, username); });
        
        stream.connection.on('chat', data => {
            const user = getUser(stream, data);
            user.commentCount += 1;
            let chatText = data.content || data.comment || data.text || data.msg || "";
            if (!chatText || String(chatText).trim() === "") chatText = "💬 [Sent a Sticker or Emote]";
            
            const chatLower = String(chatText).toLowerCase();
            let matchedVote = false;
            stream.pollKeywords.forEach(keyword => {
                if (chatLower.includes(keyword)) {
                    stream.pollCounts[keyword] += 1;
                    matchedVote = true;
                }
            });
            if (matchedVote) emitPollUpdate(stream, username);

            const commentData = { uniqueId: user.uniqueId, nickname: user.nickname, profilePictureUrl: user.profilePictureUrl, comment: String(chatText) };
            
            stream.comments.push(commentData);
            if(stream.comments.length > 500) stream.comments.shift();
            
            io.to(username).emit("newComment", commentData);
            emitUpdate(stream, username);
        });

        stream.connection.on('like', data => {
            const user = getUser(stream, data);
            user.likeCount += (data.likeCount || 1); 
            user.actualTotalLikes = user.likeCount;
            emitUpdate(stream, username);
        });

        stream.connection.on('gift', data => {
            const user = getUser(stream, data);
            user.giftCount += data.diamondCount ? (data.diamondCount * (data.repeatCount || 1)) : 1;
            emitUpdate(stream, username);
        });

        stream.connection.on('share', data => {
            const user = getUser(stream, data);
            user.shareCount += 1;
            emitUpdate(stream, username);
        });

        stream.connection.on('streamEnd', () => {
            io.to(username).emit("streamStatus", { status: "error", message: `🛑 ستریمەکە کۆتایی هات!` });
            saveStreamToD1(username, stream.stats); // Auto-save!
            if (stream.watchdog) clearInterval(stream.watchdog);
            activeStreams.delete(username);
        });

        stream.connection.on('disconnected', () => {
            console.log("Stream disconnected, attempting reconnect for @", username);
            stream.connection.connect().catch(e => {
                io.to(username).emit("streamStatus", { status: "error", message: `⚠️ پەیوەندی بە ستریمەکەوە پچڕا (Disconnected)` });
                saveStreamToD1(username, stream.stats); // Auto-save!
                if (stream.watchdog) clearInterval(stream.watchdog);
                activeStreams.delete(username);
            });
        });

        stream.connection.on('error', err => {
            console.error('TikTok Live Error for', username, ':', err);
            io.to(username).emit("streamStatus", { status: "error", message: `❌ هەڵەیەک ڕوویدا لە پەیوەندیکردن!` });
            saveStreamToD1(username, stream.stats); // Auto-save!
            if (stream.watchdog) clearInterval(stream.watchdog);
            activeStreams.delete(username);
        });
    });

    socket.on("disconnect", () => {
        delete activeSiteVisitors[socket.id];
        const username = socket.activeStreamTarget;
        if (username) {
            const stream = activeStreams.get(username);
            if (stream) {
                stream.connectedSockets.delete(socket.id);
                // We keep the stream running forever until the user manually stops it or the stream ends!
                if (stream.connectedSockets.size === 0) {
                    console.log(`User left, but keeping stream @${username} active in the background until it officially ends.`);
                }
            }
        }
    });
});

server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});