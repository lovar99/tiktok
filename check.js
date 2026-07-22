const D1_API_URL = "https://api.cloudflare.com/client/v4/accounts/680373c66f54cff8c03c582df23f66f9/d1/database/c989670d-f06b-4ca0-9f5e-473d2ff655f4/query";
const D1_API_TOKEN = "vRih21q219dK3Z48H8g6D2pSGB27-E8S2e8TqT_o";
fetch(D1_API_URL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + D1_API_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({sql: "SELECT name, sql FROM sqlite_master WHERE type='table' AND name='sessions';"})
}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d, null, 2)));
