const { TikTokLiveConnection } = require('tiktok-live-connector');
const { Server } = require("socket.io");

// THE FIX: Render will assign a port. We use that, or 3000 if running locally.
const port = process.env.PORT || 3000;
const io = new Server(port, { cors: { origin: "*" } });

io.on("connection", (socket) => {
    // Each user gets their own private memory container
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
            userStats[safeKey] = { uniqueId: rawId, nickname, profilePictureUrl: profilePic, commentCount: 0, likeCount: 0, actualTotalLikes: 0, giftCount: 0, shareCount: 0 };
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

    socket.on("startStream", (username) => {
        if (tiktokLiveConnection) {
            tiktokLiveConnection.disconnect();
        }
        userStats = {};
        
        tiktokLiveConnection = new TikTokLiveConnection(username, {});
        
        tiktokLiveConnection.connect().then(() => {
            io.emit("streamStatus", { status: "success", message: `✅ Successfully connected to @${username}!` });
        }).catch(err => {
            io.emit("streamStatus", { status: "error", message: `❌ Failed to connect to @${username}.` });
        });

        tiktokLiveConnection.on('roomUser', data => {
            if (data.viewerCount !== undefined) {
                socket.emit("viewerUpdate", { count: data.viewerCount });
            }
        });

        tiktokLiveConnection.on('member', data => {
            getUser(data); 
            emitUpdate();
        });

        tiktokLiveConnection.on('chat', data => {
            const user = getUser(data);
            user.commentCount += 1;
            
            let chatText = data.content || data.comment || data.text || data.msg || "";
            if (!chatText || String(chatText).trim() === "") {
                chatText = "💬 [Sent a Sticker or Emote]";
            }
            
            socket.emit("newComment", {
                uniqueId: user.uniqueId, 
                nickname: user.nickname,
                profilePictureUrl: user.profilePictureUrl,
                comment: String(chatText)
            });
            
            emitUpdate();
        });

        tiktokLiveConnection.on('like', data => {
            const user = getUser(data);
            user.likeCount += (data.likeCount || 1); 
            const apiTotal = data.totalLikeCount || 0;
            user.actualTotalLikes = Math.max(user.likeCount, apiTotal);
            emitUpdate();
        });

        tiktokLiveConnection.on('gift', data => {
            const user = getUser(data);
            const amount = data.diamondCount ? (data.diamondCount * (data.repeatCount || 1)) : 1;
            user.giftCount += amount;
            emitUpdate();
        });

        tiktokLiveConnection.on('share', data => {
            const user = getUser(data);
            user.shareCount += 1;
            emitUpdate();
        });
    });
});

function emitUpdate() {
    if (updateTimeout) return;
    updateTimeout = setTimeout(() => {
        const topComments = Object.values(userStats).sort((a, b) => b.commentCount - a.commentCount).slice(0, 30);
        const topLikes = Object.values(userStats).sort((a, b) => b.likeCount - a.likeCount).slice(0, 30);
        const topGifts = Object.values(userStats).sort((a, b) => b.giftCount - a.giftCount).slice(0, 30);
        const topShares = Object.values(userStats).sort((a, b) => b.shareCount - a.shareCount).slice(0, 30);
        const totalUniqueUsers = Object.keys(userStats).length;
        io.emit('leaderboardUpdate', { topComments, topLikes, topGifts, topShares, totalUniqueUsers });
        updateTimeout = null;
    }, 500); 
}