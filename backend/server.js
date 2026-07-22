const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { TikTokLiveConnection } = require("tiktok-live-connector");
const crypto = require("crypto");

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

// --- GLOBAL STREAM STATE (MULTI-TENANT) ---
const userStreams = {};

function createEmptyStreamState() {
    return {
        sessionId: null,
        username: null,
        connection: null,
        isActive: false,
        manuallyStopped: false,
        startedAt: null,
        stats: {},
        comments: [],
        leaderboard: null,
        pollKeywords: [],
        pollCounts: {},
        viewerCount: 0,
        reconnectAttempts: 0,
        reconnectTimeoutId: null,
        historySaved: false,
        checkpointIntervalId: null,
        numberGame: {
            isActive: false,
            secretNumber: null,
            minNumber: 1,
            maxNumber: 500,
            duration: 60,
            questionnMode: false,
            autoNextRound: false,
            timerId: null,
            remainingTime: 0,
            closestGuess: null,
            clues: [],
            availableClues: [],
            winner: null,
            roundEnded: false
        },
        mazeGame: {
            isActive: false,
            phase: "inactive",
            registeredPlayers: [],
            selectedPlayer: null,
            maze: [],
            width: 11,
            height: 11,
            playerPos: { x: 0, y: 0 },
            exitPos: { x: 0, y: 0 },
            traps: [],
            duration: 60,
            remainingTime: 0,
            lives: 3,
            initialLives: 3,
            trapsEnabled: false,
            limitedView: false,
            timerId: null,
            winner: false
        }
    };
}

function parseEasternNumerals(str) {
    const numerals = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
    let converted = str.replace(/[٠-٩]/g, d => numerals[d]);
    let match = converted.match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
}

// CLOUDFLARE D1 DATABASE CONFIGURATION
const D1_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "680373c66f54cff8c03c582df23f66f9";
const D1_DATABASE_ID = process.env.CF_D1_ID || "c989670d-f06b-4ca0-9f5e-473d2ff655f4";
const D1_API_URL = `https://api.cloudflare.com/client/v4/accounts/${D1_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;
const D1_API_TOKEN = process.env.CF_API_TOKEN;

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

// --- RENDER RESTART RECOVERY (D1 Checkpoint) ---
async function recoverActiveStream(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    try {
        const res = await queryD1(`SELECT settings_data FROM user_settings WHERE username = '_SYSTEM_GLOBAL_STREAM_'`);
        const row = res.result?.[0]?.results?.[0];
        if (row && row.settings_data) {
            const savedState = JSON.parse(row.settings_data);
            if (savedState.isActive && !savedState.manuallyStopped && !savedState.historySaved) {
                console.log(`[Startup] Recovered active stream for @${savedState.username} from D1 checkpoint. Attempting to resume tracking...`);
                // Restore state into memory
                globalStream.sessionId = savedState.sessionId;
                globalStream.username = savedState.username;
                globalStream.isActive = true;
                globalStream.manuallyStopped = false;
                globalStream.startedAt = savedState.startedAt;
                
                // --- SANITIZE BROKEN CHECKPOINT STATE ---
                if (savedState.stats) {
                    Object.keys(savedState.stats).forEach(k => {
                        if (k === "undefined" || !savedState.stats[k].uniqueId || String(savedState.stats[k].uniqueId).includes("nown")) {
                            delete savedState.stats[k];
                        }
                    });
                }
                if (savedState.comments) {
                    savedState.comments = savedState.comments.filter(c => c.uniqueId && c.uniqueId !== "undefined" && !String(c.uniqueId).includes("nown"));
                }
                
                globalStream.stats = savedState.stats || {};
                globalStream.comments = savedState.comments || [];
                
                // Re-sort leaderboard after sanitization
                const sortedUsers = Object.values(globalStream.stats)
                    .sort((a, b) => (b.giftCount * 1000 + b.commentCount * 10 + b.actualTotalLikes) - (a.giftCount * 1000 + a.commentCount * 10 + a.actualTotalLikes))
                    .slice(0, 100);
                globalStream.leaderboard = { totalUniqueUsers: Object.keys(globalStream.stats).length, topUsers: sortedUsers };
                globalStream.pollKeywords = savedState.pollKeywords || [];
                globalStream.pollCounts = savedState.pollCounts || {};
                globalStream.viewerCount = savedState.viewerCount || 0;
                globalStream.reconnectAttempts = 0;
                globalStream.historySaved = false;

                startCheckpointing();
                initializeTikTokConnection(adminUsername, globalStream.username);
            }
        }
    } catch (e) {
        console.error("[Startup] Failed to recover active stream state from D1", e);
    }
}

function saveStreamCheckpoint(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    if (!globalStream.isActive) return;
    const checkpointData = {
        sessionId: globalStream.sessionId,
        username: globalStream.username,
        isActive: globalStream.isActive,
        manuallyStopped: globalStream.manuallyStopped,
        startedAt: globalStream.startedAt,
        stats: globalStream.stats,
        comments: globalStream.comments,
        leaderboard: globalStream.leaderboard,
        pollKeywords: globalStream.pollKeywords,
        pollCounts: globalStream.pollCounts,
        viewerCount: globalStream.viewerCount,
        historySaved: globalStream.historySaved
    };
    queryD1(`
        INSERT INTO user_settings (username, settings_data) 
        VALUES ('_SYSTEM_GLOBAL_STREAM_', ?) 
        ON CONFLICT(username) DO UPDATE SET settings_data = excluded.settings_data
    `, [JSON.stringify(checkpointData)]).catch(e => console.error("Checkpoint error", e));
}

function startCheckpointing(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    if (globalStream.checkpointIntervalId) clearInterval(globalStream.checkpointIntervalId);
    globalStream.checkpointIntervalId = setInterval(saveStreamCheckpoint, 30000); // Checkpoint every 30s
}

async function clearStreamCheckpoint(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    await queryD1(`DELETE FROM user_settings WHERE username = '_SYSTEM_GLOBAL_STREAM_'`);
}

// Exactly-Once History Saving
async function saveStreamToD1Once(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    if (globalStream.historySaved || !globalStream.username) return;
    globalStream.historySaved = true;

    try {
        const sessionDataObj = {
            sessionId: globalStream.sessionId,
            startedAt: globalStream.startedAt,
            endedAt: new Date().toISOString(),
            stats: globalStream.stats,
            leaderboard: globalStream.leaderboard,
            pollCounts: globalStream.pollCounts,
            comments: globalStream.comments, 
            viewerCount: globalStream.viewerCount
        };
        const sessionDataStr = JSON.stringify(sessionDataObj);
        
        await queryD1(`INSERT INTO sessions (username, session_data) VALUES (?, ?)`, [globalStream.username, sessionDataStr]);
        console.log(`[Stream Ended] Auto-saved session for @${globalStream.username} to Live History exactly once.`);
        io.to(adminUsername).emit("streamStatus", { status: "success", message: "✅ دانیشتنەکە پاشەکەوت کرا لە بنکەی دراوە! (Saved to DB)" });
    } catch (e) {
        console.error("Failed to save stream history", e);
    }
}

function emitPollUpdate(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    const sorted = Object.keys(globalStream.pollCounts)
        .sort((a, b) => globalStream.pollCounts[b] - globalStream.pollCounts[a])
        .slice(0, 3)
        .map(k => ({ keyword: k, count: globalStream.pollCounts[k] }));
    io.to(adminUsername).emit("pollUpdate", sorted);
}

function getUser(adminUsername, data) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    const userObj = data.user || data;
    
    // Attempt to extract the unique ID from various known TikTok protobuf fields
    const uid = userObj.uniqueId || userObj.displayId || userObj.userId || userObj.idStr || userObj.secUid || (userObj.id ? userObj.id.toString() : null);
    
    // If uniqueId is completely missing, fallback to nickname or random
    const finalUid = uid || userObj.nickname || ("unknown_" + Math.random().toString(36).substr(2, 9));
    
    // Attempt to extract profile picture from various known fields
    let profilePic = "https://www.tiktok.com/favicon.ico";
    if (userObj.profilePictureUrl) {
        profilePic = userObj.profilePictureUrl;
    } else if (userObj.avatarUrl) {
        profilePic = userObj.avatarUrl;
    } else if (userObj.avatarThumb && userObj.avatarThumb.urlList && userObj.avatarThumb.urlList.length > 0) {
        profilePic = userObj.avatarThumb.urlList[0];
    } else if (userObj.avatarMedium && userObj.avatarMedium.urlList && userObj.avatarMedium.urlList.length > 0) {
        profilePic = userObj.avatarMedium.urlList[0];
    } else if (userObj.avatarLarge && userObj.avatarLarge.urlList && userObj.avatarLarge.urlList.length > 0) {
        profilePic = userObj.avatarLarge.urlList[0];
    }

    if (!globalStream.stats[finalUid]) {
        globalStream.stats[finalUid] = { 
            uniqueId: finalUid, 
            nickname: userObj.nickname || userObj.displayId || "Unknown", 
            profilePictureUrl: profilePic, 
            commentCount: 0, 
            likeCount: 0, 
            actualTotalLikes: 0, 
            giftCount: 0, 
            shareCount: 0 
        };
    }
    return globalStream.stats[finalUid];
}

function emitUpdate(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    const activeUsersCount = Object.keys(globalStream.stats).length;
    const sortedUsers = Object.values(globalStream.stats)
        .sort((a, b) => (b.giftCount * 1000 + b.commentCount * 10 + b.actualTotalLikes) - (a.giftCount * 1000 + a.commentCount * 10 + a.actualTotalLikes))
        .slice(0, 100);
    
    globalStream.leaderboard = { totalUniqueUsers: activeUsersCount, topUsers: sortedUsers };
    io.to(adminUsername).emit("leaderboardUpdate", globalStream.leaderboard);
}

function initializeTikTokConnection(adminUsername, username) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    if (globalStream.connection) {
        try { globalStream.connection.disconnect(); } catch (e) {}
    }
    
    globalStream.connection = new TikTokLiveConnection(username, {});
    
    globalStream.connection.connect().then(() => {
        globalStream.reconnectAttempts = 0;
        console.log(`[TikTok] Connected to @${username}`);
        io.to(adminUsername).emit("streamStatus", { status: "success", message: `✅ سەرکەوتوو بوو! پەیوەست بوو بە @${username}` });
    }).catch(err => {
        handleConnectionDrop(adminUsername, err);
    });

    globalStream.connection.on('roomUser', data => { if (data.viewerCount !== undefined) { globalStream.viewerCount = data.viewerCount; io.to(adminUsername).emit("viewerUpdate", { count: data.viewerCount }); } });
    globalStream.connection.on('room', data => { if (data.viewerCount !== undefined) { globalStream.viewerCount = data.viewerCount; io.to(adminUsername).emit("viewerUpdate", { count: data.viewerCount }); } });
    
    globalStream.connection.on('member', data => { getUser(adminUsername, data); emitUpdate(adminUsername); });
    
    globalStream.connection.on('chat', data => {
        const user = getUser(adminUsername, data);
        user.commentCount += 1;
        let chatText = data.content || data.comment || data.text || data.msg || "";
        if (!chatText || String(chatText).trim() === "") chatText = "💬 [Sent a Sticker or Emote]";
        
        const chatLower = String(chatText).toLowerCase();
        let matchedVote = false;
        globalStream.pollKeywords.forEach(keyword => {
            if (chatLower.includes(keyword)) {
                globalStream.pollCounts[keyword] += 1;
                matchedVote = true;
            }
        });
        if (matchedVote) emitPollUpdate(adminUsername);

        const commentData = { uniqueId: user.uniqueId, nickname: user.nickname, profilePictureUrl: user.profilePictureUrl, comment: String(chatText) };
        
        // Secret Number Game Logic
        const game = globalStream.numberGame;
        if (game.isActive && !game.roundEnded) {
            let guessNum = parseEasternNumerals(chatText);
            if (guessNum !== null && guessNum >= game.minNumber && guessNum <= game.maxNumber) {
                processNumberGameGuess(adminUsername, user, guessNum);
            }
        }

        // Escape the Maze Game Logic
        const mGame = globalStream.mazeGame;
        if (mGame.isActive) {
            if (mGame.phase === 'registration' && String(chatText).trim() === '100') {
                if (!mGame.registeredPlayers.find(p => p.uniqueId === user.uniqueId)) {
                    mGame.registeredPlayers.push({ uniqueId: user.uniqueId, nickname: user.nickname });
                    io.to(adminUsername).emit("mazeGameRegistered", mGame.registeredPlayers);
                }
            } else if (mGame.phase === 'playing' && mGame.selectedPlayer && user.uniqueId === mGame.selectedPlayer.uniqueId) {
                processMazeCommand(adminUsername, user, String(chatText));
            }
        }

        globalStream.comments.push(commentData);
        if(globalStream.comments.length > 500) globalStream.comments.shift();
        
        io.to(adminUsername).emit("newComment", commentData);
        emitUpdate(adminUsername);
    });

    globalStream.connection.on('like', data => {
        const user = getUser(adminUsername, data);
        if (data.totalLikeCount !== undefined) {
            user.likeCount = data.totalLikeCount;
        } else {
            user.likeCount += (data.likeCount || 1);
        }
        user.actualTotalLikes = user.likeCount;
        emitUpdate(adminUsername);
    });

    globalStream.connection.on('gift', data => {
        const user = getUser(adminUsername, data);
        user.giftCount += data.diamondCount ? (data.diamondCount * (data.repeatCount || 1)) : 1;
        emitUpdate(adminUsername);
    });

    globalStream.connection.on('share', data => {
        const user = getUser(adminUsername, data);
        user.shareCount += 1;
        emitUpdate(adminUsername);
    });

    // ACTUAL STREAM END
    globalStream.connection.on('streamEnd', async () => {
        console.log(`[TikTok] Stream ENDED for @${globalStream.username}`);
        io.to(adminUsername).emit("streamStatus", { status: "error", message: `🛑 ستریمەکە کۆتایی هات!` });
        
        clearTimeout(globalStream.reconnectTimeoutId);
        clearInterval(globalStream.checkpointIntervalId);
        
        await saveStreamToD1Once(adminUsername);
        await clearStreamCheckpoint(adminUsername);
        
        resetGlobalStream(adminUsername);
    });

    // TEMPORARY DISCONNECT
    globalStream.connection.on('disconnected', () => {
        console.log(`[TikTok] Disconnected from @${globalStream.username}. Attempting reconnect...`);
        handleConnectionDrop(adminUsername, "Disconnected event");
    });

    globalStream.connection.on('error', err => {
        console.error(`[TikTok] Error for @${globalStream.username}:`, err);
        handleConnectionDrop(adminUsername, err);
    });
}

function handleConnectionDrop(adminUsername, err) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    if (globalStream.manuallyStopped || !globalStream.isActive) return;

    if (globalStream.reconnectAttempts >= 10) {
        console.log(`[TikTok] Max reconnect attempts reached for @${globalStream.username}. Failing stream.`);
        io.to(adminUsername).emit("streamStatus", { status: "error", message: `❌ هەڵەیەک ڕوویدا لە پەیوەندیکردن! ستریمەکە وەستا.` });
        
        // Treat as ended to ensure data isn't lost
        clearInterval(globalStream.checkpointIntervalId);
        saveStreamToD1Once(adminUsername).then(() => clearStreamCheckpoint(adminUsername)).then(() => resetGlobalStream(adminUsername));
        return;
    }

    globalStream.reconnectAttempts++;
    const delayMs = Math.min(1000 * Math.pow(2, globalStream.reconnectAttempts), 30000); // 2s, 4s, 8s, 16s, 30s max
    
    console.log(`[TikTok] Scheduling reconnect attempt ${globalStream.reconnectAttempts} in ${delayMs}ms...`);
    io.to(adminUsername).emit("streamStatus", { status: "error", message: `⚠️ پەیوەندی پچڕا. هەوڵی دووبارە پەیوەندیکردن دەدات (${globalStream.reconnectAttempts}/10)...` });
    
    clearTimeout(globalStream.reconnectTimeoutId);
    globalStream.reconnectTimeoutId = setTimeout(() => {
        if (!globalStream.manuallyStopped && globalStream.isActive) {
            console.log(`[TikTok] Executing reconnect attempt ${globalStream.reconnectAttempts}...`);
            initializeTikTokConnection(adminUsername, globalStream.username);
        }
    }, delayMs);
}

function resetGlobalStream(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    if (globalStream.connection) {
        try { globalStream.connection.disconnect(); } catch (e) {}
    }
    clearTimeout(globalStream.reconnectTimeoutId);
    clearInterval(globalStream.checkpointIntervalId);

    globalStream.sessionId = null;
    globalStream.username = null;
    globalStream.connection = null;
    globalStream.isActive = false;
    globalStream.manuallyStopped = false;
    globalStream.startedAt = null;
    globalStream.stats = {};
    globalStream.comments = [];
    globalStream.leaderboard = null;
    globalStream.pollKeywords = [];
    globalStream.pollCounts = {};
    globalStream.viewerCount = 0;
    globalStream.reconnectAttempts = 0;
    globalStream.historySaved = false;
    if (globalStream.numberGame && globalStream.numberGame.timerId) {
        clearInterval(globalStream.numberGame.timerId);
    }
    globalStream.numberGame = {
        isActive: false, secretNumber: null, minNumber: 1, maxNumber: 500, duration: 60,
        questionnMode: false, autoNextRound: false, timerId: null, remainingTime: 0,
        closestGuess: null, clues: [], availableClues: [], winner: null, roundEnded: false
    };
}

// --- NUMBER GAME ENGINE ---
function startNumberGameRound(adminUsername, settings) {
    const game = globalStream.numberGame;
    if (game.isActive && !game.roundEnded && game.timerId) return; // already running
    
    game.minNumber = parseInt(settings.minNumber) || 1;
    game.maxNumber = parseInt(settings.maxNumber) || 500;
    game.duration = parseInt(settings.duration) || 60;
    game.questionnMode = !!settings.questionnMode;
    game.autoNextRound = !!settings.autoNextRound;
    
    game.secretNumber = Math.floor(Math.random() * (game.maxNumber - game.minNumber + 1)) + game.minNumber;
    
    game.isActive = true;
    game.roundEnded = false;
    game.remainingTime = game.duration;
    game.closestGuess = null;
    game.winner = null;
    game.clues = [];
    
    const clueList = [];
    if (game.secretNumber % 2 === 0) clueList.push("ژمارەکە ژمارەیەکی جوتە");
    else clueList.push("ژمارەکە ژمارەیەکی تاکە");
    
    if (game.secretNumber % 5 === 0) clueList.push("ژمارەکە بەسەر ٥ دابەش دەبێت");
    else clueList.push("ژمارەکە بەسەر ٥ دابەش نابێت");
    
    let rangeStep = Math.max(50, Math.floor((game.maxNumber - game.minNumber) / 4));
    let lowerBound = game.secretNumber - (game.secretNumber % rangeStep);
    let upperBound = lowerBound + rangeStep;
    clueList.push(`ژمارەکە لە نێوان ${lowerBound} بۆ ${upperBound} ـە`);
    
    game.availableClues = clueList.sort(() => Math.random() - 0.5);

    if (game.timerId) clearInterval(game.timerId);
    
    io.to(adminUsername).emit("numberGameStarted", {
        minNumber: game.minNumber,
        maxNumber: game.maxNumber,
        duration: game.duration,
        questionnMode: game.questionnMode
    });

    game.timerId = setInterval(() => {
        game.remainingTime -= 1;
        
        if (game.remainingTime === Math.floor(game.duration * 0.66) && game.availableClues.length > 0) {
            let clue = game.availableClues.pop();
            game.clues.push(clue);
            io.to(adminUsername).emit("numberGameClue", clue);
        }
        if (game.remainingTime === Math.floor(game.duration * 0.33) && game.availableClues.length > 0) {
            let clue = game.availableClues.pop();
            game.clues.push(clue);
            io.to(adminUsername).emit("numberGameClue", clue);
        }
        if (game.remainingTime === 10 && game.availableClues.length > 0) {
            let clue = game.availableClues.pop();
            let finalClue = `🚨 ئاماژەی کۆتایی: ${clue}`;
            game.clues.push(finalClue);
            io.to(adminUsername).emit("numberGameClue", finalClue);
        }

        io.to(adminUsername).emit("numberGameTick", { remainingTime: game.remainingTime });

        if (game.remainingTime <= 0) {
            endNumberGameRound(game.closestGuess);
        }
    }, 1000);
}

function processNumberGameGuess(adminUsername, user, guessNum) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    const game = globalStream.numberGame;

    if (game.questionnMode && guessNum === game.secretNumber) {
        // Unwinnable mode! Change the secret number secretly.
        let newNum;
        do {
            newNum = Math.floor(Math.random() * (game.maxNumber - game.minNumber + 1)) + game.minNumber;
        } while (newNum === game.secretNumber);
        game.secretNumber = newNum;
    }

    const distance = Math.abs(guessNum - game.secretNumber);
    
    let feedback = "";
    if (distance === 0) feedback = "🎯 ڕاستە!";
    else if (distance <= 5) feedback = "🔥🔥 زۆر زۆر نزیکە";
    else if (distance <= 20) feedback = "🔥 نزیکە";
    else if (distance <= 100) feedback = "😐 مامناوەندە";
    else if (distance <= 200) feedback = "🥶 دوورە";
    else feedback = "❄️ زۆر دوورە";
    
    const guessData = {
        uniqueId: user.uniqueId,
        nickname: user.nickname,
        guess: guessNum,
        distance: distance,
        feedback: feedback,
        timestamp: Date.now()
    };
    
    io.to(adminUsername).emit("numberGameGuess", guessData);

    if (!game.closestGuess || distance < game.closestGuess.distance) {
        game.closestGuess = guessData;
        io.to(adminUsername).emit("numberGameClosest", game.closestGuess);
    }

    if (distance === 0 && !game.questionnMode) {
        endNumberGameRound(guessData);
    }
}

function endNumberGameRound(winnerData) {
    const game = globalStream.numberGame;
    if (game.timerId) clearInterval(game.timerId);
    game.roundEnded = true;
    game.winner = winnerData;
    
    io.to(adminUsername).emit("numberGameEnded", {
        secretNumber: game.secretNumber,
        winner: game.winner,
        closestGuess: game.closestGuess
    });
    
    if (game.autoNextRound) {
        setTimeout(() => {
            if (globalStream.numberGame.isActive && globalStream.numberGame.roundEnded) {
                startNumberGameRound(globalStream.numberGame);
            }
        }, 15000);
    }
}

// --- ESCAPE THE MAZE GAME LOGIC ---

function generateMaze(width, height, trapsEnabled) {
    if (width % 2 === 0) width++;
    if (height % 2 === 0) height++;

    let maze = Array(height).fill().map(() => Array(width).fill(1)); // 1 = wall

    function carve(x, y) {
        maze[y][x] = 0; // 0 = path
        let dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
        dirs.sort(() => Math.random() - 0.5);

        for (let [dx, dy] of dirs) {
            let nx = x + dx * 2, ny = y + dy * 2;
            if (nx > 0 && nx < width - 1 && ny > 0 && ny < height - 1 && maze[ny][nx] === 1) {
                maze[y + dy][x + dx] = 0;
                carve(nx, ny);
            }
        }
    }

    carve(1, 1);
    maze[height-2][width-2] = 0; 

    let traps = [];
    if (trapsEnabled) {
        let pathCells = [];
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                if (maze[y][x] === 0 && !(x === 1 && y === 1) && !(x === width-2 && y === height-2)) {
                    pathCells.push({x, y});
                }
            }
        }
        let trapCount = Math.floor((width * height) / 30);
        pathCells.sort(() => Math.random() - 0.5);
        for(let i=0; i<trapCount && i<pathCells.length; i++) {
            let t = pathCells[i];
            maze[t.y][t.x] = 2;
            traps.push(t);
        }
    }

    return { maze, width, height, playerPos: {x: 1, y: 1}, exitPos: {x: width-2, y: height-2}, traps };
}

function getSafeMazeGameState(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    const mGame = globalStream.mazeGame;
    return {
        isActive: mGame.isActive,
        phase: mGame.phase,
        registeredPlayers: mGame.registeredPlayers,
        selectedPlayer: mGame.selectedPlayer,
        maze: mGame.maze,
        width: mGame.width,
        height: mGame.height,
        playerPos: mGame.playerPos,
        exitPos: mGame.exitPos,
        traps: mGame.traps,
        remainingTime: mGame.remainingTime,
        lives: mGame.lives,
        initialLives: mGame.initialLives,
        trapsEnabled: mGame.trapsEnabled,
        limitedView: mGame.limitedView,
        winner: mGame.winner
    };
}

function startMazeRegistration(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    const mGame = globalStream.mazeGame;
    mGame.isActive = true;
    mGame.phase = 'registration';
    mGame.registeredPlayers = [];
    mGame.selectedPlayer = null;
    io.to(adminUsername).emit("mazeGameState", getSafeMazeGameState(adminUsername));
}

function startMazeGame(adminUsername, settings) {
    const mGame = globalStream.mazeGame;
    if (!mGame.selectedPlayer) return;

    mGame.phase = 'playing';
    mGame.width = settings.width || 11;
    mGame.height = settings.height || 11;
    mGame.duration = settings.duration || 60;
    mGame.remainingTime = mGame.duration;
    mGame.initialLives = settings.lives || 3;
    mGame.lives = mGame.initialLives;
    mGame.trapsEnabled = settings.trapsEnabled || false;
    mGame.limitedView = settings.limitedView || false;
    mGame.winner = false;

    const generated = generateMaze(mGame.width, mGame.height, mGame.trapsEnabled);
    mGame.maze = generated.maze;
    mGame.playerPos = generated.playerPos;
    mGame.exitPos = generated.exitPos;
    mGame.traps = generated.traps;

    if (mGame.timerId) clearInterval(mGame.timerId);
    mGame.timerId = setInterval(() => {
        mGame.remainingTime -= 1;
        io.to(adminUsername).emit("mazeGameTick", { remainingTime: mGame.remainingTime });
        if (mGame.remainingTime <= 0) {
            endMazeGame('time');
        }
    }, 1000);

    io.to(adminUsername).emit("mazeGameState", getSafeMazeGameState(adminUsername));
}

function processMazeCommand(adminUsername, user, text) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    const mGame = globalStream.mazeGame;
    if (mGame.phase !== 'playing') return;

    const chars = text.split('');
    let moved = false;
    let feedbackMsgs = [];
    let dx = 0; let dy = 0;

    for (let char of chars) {
        if (mGame.phase !== 'playing') break;
        let nx = mGame.playerPos.x;
        let ny = mGame.playerPos.y;
        let moveName = "";

        if (char === 'ر') { nx -= 1; moveName = "ڕاست"; }
        else if (char === 'چ') { nx += 1; moveName = "چەپ"; }
        else if (char === 'س') { ny -= 1; moveName = "سەرەوە"; }
        else if (char === 'خ') { ny += 1; moveName = "خوارەوە"; }
        else continue;

        if (nx >= 0 && nx < mGame.width && ny >= 0 && ny < mGame.height) {
            if (mGame.maze[ny][nx] === 1) {
                feedbackMsgs.push("🧱 دیوارە!");
            } else {
                mGame.playerPos.x = nx;
                mGame.playerPos.y = ny;
                dx += (nx - mGame.playerPos.x); // To aggregate steps logic if needed
                moved = true;

                if (mGame.maze[ny][nx] === 2) { // Trap
                    feedbackMsgs.push("💥 تەڵە!");
                    mGame.maze[ny][nx] = 0; // Trigger once
                    mGame.remainingTime = Math.max(0, mGame.remainingTime - 3);
                    mGame.lives -= 1;
                    if (mGame.lives <= 0) {
                        endMazeGame('lives');
                        break;
                    }
                }

                if (nx === mGame.exitPos.x && ny === mGame.exitPos.y) {
                    endMazeGame('win');
                    break;
                }
            }
        }
    }

    if (moved || feedbackMsgs.length > 0) {
        io.to(adminUsername).emit("mazeGameMove", {
            playerPos: mGame.playerPos,
            remainingTime: mGame.remainingTime,
            lives: mGame.lives,
            feedbacks: feedbackMsgs,
            user: user.nickname,
            text: text
        });
    }
}

function endMazeGame(reason) {
    const mGame = globalStream.mazeGame;
    if (mGame.timerId) clearInterval(mGame.timerId);
    mGame.phase = 'ended';
    if (reason === 'win') mGame.winner = true;
    else mGame.winner = false;
    
    io.to(adminUsername).emit("mazeGameEnded", { reason: reason, winner: mGame.winner });
}

function stopMazeGame(adminUsername) {
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    const mGame = globalStream.mazeGame;
    if (mGame.timerId) clearInterval(mGame.timerId);
    mGame.isActive = false;
    mGame.phase = 'inactive';
    io.to(adminUsername).emit("mazeGameState", getSafeMazeGameState(adminUsername));
}


// --- SOCKET.IO LIVE TRACKING LOGIC ---
io.on("connection", (socket) => {
    const adminUsername = socket.handshake.auth.username;
    if (!adminUsername || adminUsername === "unknown") return socket.disconnect();
    
    socket.join(adminUsername);
    if (!userStreams[adminUsername]) userStreams[adminUsername] = createEmptyStreamState();
    const globalStream = userStreams[adminUsername];

    activeSiteVisitors[socket.id] = { connectedAt: new Date().toISOString() };

    socket.on("setPollKeywords", (keywords) => {
        globalStream.pollKeywords = keywords.map(k => String(k).trim().toLowerCase());
        globalStream.pollKeywords.forEach(k => {
            if (globalStream.pollCounts[k] === undefined) globalStream.pollCounts[k] = 0;
        });
        emitPollUpdate(adminUsername);
    });

    socket.on("getAllUsers", () => {
        if (globalStream.isActive) {
            socket.emit("allUsersData", Object.values(globalStream.stats));
        }
    });

    socket.on("requestInitialState", async (adminUser) => {
        const syncData = {
            isActive: globalStream.isActive,
            currentTrackedUsername: globalStream.username,
            allComments: globalStream.comments,
            leaderboard: globalStream.leaderboard,
            pollKeywords: globalStream.pollKeywords,
            pollCounts: globalStream.pollCounts,
            viewerCount: globalStream.viewerCount
        };

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
        
        // Push current number game state
        const game = globalStream.numberGame;
        if (game.isActive) {
            syncData.numberGame = {
                isActive: game.isActive,
                roundEnded: game.roundEnded,
                minNumber: game.minNumber,
                maxNumber: game.maxNumber,
                remainingTime: game.remainingTime,
                closestGuess: game.closestGuess,
                questionnMode: game.questionnMode,
                clues: game.clues,
                questionnMode: game.questionnMode,
                secretNumber: game.roundEnded ? game.secretNumber : null,
                winner: game.winner
            };
        }

        const mGame = globalStream.mazeGame;
        if (mGame.isActive) {
            syncData.mazeGame = getSafeMazeGameState(adminUsername);
        }

        socket.emit("initialState", syncData);
    });

    socket.on("startNumberGame", (settings) => {
        startNumberGameRound(adminUsername, settings);
    });

    socket.on("stopNumberGame", () => {
        const game = globalStream.numberGame;
        if (game.timerId) clearInterval(game.timerId);
        game.isActive = false;
        io.to(adminUsername).emit("numberGameEnded", { stopped: true });
    });

    socket.on("startMazeRegistration", () => {
        startMazeRegistration(adminUsername);
    });

    socket.on("selectMazePlayer", (uniqueId) => {
        const mGame = globalStream.mazeGame;
        if (mGame.phase === 'registration') {
            const player = mGame.registeredPlayers.find(p => p.uniqueId === uniqueId);
            if (player) {
                mGame.selectedPlayer = player;
                io.to(adminUsername).emit("mazeGameState", getSafeMazeGameState(adminUsername));
            }
        }
    });

    socket.on("startMazeGame", (settings) => {
        startMazeGame(adminUsername, settings);
    });

    socket.on("stopMazeGame", () => {
        stopMazeGame(adminUsername);
    });

    socket.on("clearMazePlayers", () => {
        globalStream.mazeGame.registeredPlayers = [];
        globalStream.mazeGame.selectedPlayer = null;
        io.to(adminUsername).emit("mazeGameState", getSafeMazeGameState(adminUsername));
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

    socket.on("saveSessionToD1", async (username) => {
        // Only allow manual save if it matches the current active stream and hasn't been saved
        if (globalStream.isActive && globalStream.username === username && !globalStream.historySaved) {
            await saveStreamToD1Once(adminUsername);
        }
    });

    socket.on("getPastSessions", async () => {
        const res = await queryD1(`SELECT id, username, start_time FROM sessions ORDER BY id DESC LIMIT 20`);
        if (!res || !res.success) {
            socket.emit("streamStatus", { status: "error", message: `D1 Error: ${res?.error?.message || res?.error || "Unknown error"}` });
        }
        socket.emit("pastSessionsData", res?.result?.[0]?.results || []);
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
        io.to(adminUsername).emit("forceLogout", username);
    });

    socket.on("adminAddUser", async (data) => {
        const hash = await bcrypt.hash(data.password, 10);
        await queryD1(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, [data.username, hash, 'user']);
        socket.emit("adminRefresh");
    });

    socket.on("stopStream", async () => {
        if (!globalStream.isActive) return;
        
        console.log(`[Manual Stop] Tracker explicitly stopped for @${globalStream.username}.`);
        globalStream.manuallyStopped = true;
        
        clearTimeout(globalStream.reconnectTimeoutId);
        clearInterval(globalStream.checkpointIntervalId);
        
        await saveStreamToD1Once(adminUsername);
        await clearStreamCheckpoint();
        
        resetGlobalStream();
        io.to(adminUsername).emit("streamStatus", { status: "error", message: `🛑 ستریمەکە وەستێنرا لەلایەن بەکارهێنەر!` });
    });

    socket.on("startStream", (username) => {
        if (!username || username.trim() === "") return;

        // Idempotent start behavior
        if (globalStream.isActive && globalStream.username === username) {
            socket.emit("streamStatus", { status: "success", message: `✅ پەیوەست بوو بە ستریمی چالاک: @${username}` });
            return;
        }

        // If a different stream is running, stop it first safely
        if (globalStream.isActive) {
            console.log(`[Manual Change] Switching from @${globalStream.username} to @${username}. Saving old stream...`);
            saveStreamToD1Once(adminUsername).then(() => clearStreamCheckpoint());
            resetGlobalStream();
        }

        // Initialize a new global stream
        globalStream.sessionId = crypto.randomUUID();
        globalStream.username = username;
        globalStream.isActive = true;
        globalStream.manuallyStopped = false;
        globalStream.startedAt = new Date().toISOString();
        globalStream.stats = {};
        globalStream.comments = [];
        globalStream.leaderboard = null;
        globalStream.pollKeywords = [];
        globalStream.pollCounts = {};
        globalStream.viewerCount = 0;
        globalStream.reconnectAttempts = 0;
        globalStream.historySaved = false;

        startCheckpointing();
        initializeTikTokConnection(adminUsername, username);
    });

    socket.on("disconnect", () => {
        delete activeSiteVisitors[socket.id];
        // Stream keeps running unconditionally on socket disconnect.
    });
});

// Run startup recovery
recoverActiveStream().then(() => {
    server.listen(port, () => {
        console.log(`🚀 Server running on port ${port}`);
    });
});