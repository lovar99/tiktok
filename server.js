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
        socket.emit('leaderboardUpdate', { topComments, topLikes, topGifts, topShares, totalUniqueUsers: Object.keys(userStats).length });
    }

    socket.on("getAllUsers", () => socket.emit("allUsersData", Object.values(userStats)));

    // --- SECRET ADMIN PANEL REQUEST ---
    socket.on("requestAdminPanel", async () => {
        // Fetch real analytics from D1
        const totalVisitsRes = await queryD1(`SELECT COUNT(*) as count FROM analytics`);
        const usersRes = await queryD1(`SELECT id, username, role, created_at FROM users`);
        
        const totalVisits = totalVisitsRes.result?.[0]?.results?.[0]?.count || 0;
        const dbUsers = usersRes.result?.[0]?.results || [];

        let adminHtml = `
            <div style="color: white;">
                <h3>📊 ئامارەکانی وێبسایت</h3>
                <p>سەردانی گشتی: <b>${totalVisits}</b></p>
                <p>بەکارهێنەرە چالاکەکانی ئێستا: <b>${Object.keys(activeSiteVisitors).length}</b></p>
                <hr style="border-color:#333">
                <h3>👥 هەژمارەکان</h3>
                <table style="width:100%; text-align:left; border-collapse: collapse;">
                    <tr style="background:#2a2a2a;"><th>ID</th><th>ناو</th><th>ڕۆڵ</th><th>بەروار</th></tr>
                    ${dbUsers.map(u => `<tr><td>${u.id}</td><td>${u.username}</td><td>${u.role}</td><td>${u.created_at.split('T')[0]}</td></tr>`).join('')}
                </table>
            </div>
        `;
        socket.emit("adminPanelData", adminHtml);
    });

    socket.on("startStream", (username) => {
        if (tiktokLiveConnection) tiktokLiveConnection.disconnect();
        userStats = {};
        tiktokLiveConnection = new TikTokLiveConnection(username, {});
        
        tiktokLiveConnection.connect().then(() => {
            socket.emit("streamStatus", { status: "success", message: `✅ Successfully connected to @${username}!` });
        }).catch(err => {
            socket.emit("streamStatus", { status: "error", message: `❌ Failed to connect to @${username}.` });
        });

        tiktokLiveConnection.on('roomUser', data => { if (data.viewerCount !== undefined) socket.emit("viewerUpdate", { count: data.viewerCount }); });
        tiktokLiveConnection.on('room', data => { if (data.viewerCount !== undefined) socket.emit("viewerUpdate", { count: data.viewerCount }); });
        
        tiktokLiveConnection.on('member', data => { getUser(data); emitUpdate(); });
        
        tiktokLiveConnection.on('chat', data => {
            const user = getUser(data);
            user.commentCount += 1;
            let chatText = data.content || data.comment || data.text || data.msg || "";
            if (!chatText || String(chatText).trim() === "") chatText = "💬 [Sent a Sticker or Emote]";
            socket.emit("newComment", { uniqueId: user.uniqueId, nickname: user.nickname, profilePictureUrl: user.profilePictureUrl, comment: String(chatText) });
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