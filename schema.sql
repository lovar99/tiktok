CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE login_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_time DATETIME,
    duration_minutes INTEGER
);

CREATE TABLE analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT,
    visit_date DATE DEFAULT CURRENT_DATE,
    visit_time DATETIME DEFAULT CURRENT_TIMESTAMP
);