"""
AirAura backend: Flask API (auth, favorites, cached Open-Meteo proxy, ML prediction)
and static hosting of ../frontend for local development.
"""
import os
import re
import sqlite3
import datetime as dt
import pathlib
from functools import wraps

import jwt
import joblib
import numpy as np
import requests
from cachetools import TTLCache
from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_from_directory
from flask_compress import Compress
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()
BASE = pathlib.Path(__file__).parent
FRONTEND_DIR = (BASE.parent / "frontend").resolve()

SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-secret-change-me")
DB_PATH = os.getenv("DB_PATH", str(BASE / "airaura.db"))
CACHE_TTL = int(os.getenv("CACHE_TTL", "600"))  # seconds (10 minutes)
ORIGINS = [o.strip() for o in os.getenv("FRONTEND_ORIGINS", "*").split(",") if o.strip()]

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
Compress(app)  # gzip responses
CORS(app, origins=ORIGINS if ORIGINS != ["*"] else "*", allow_headers=["Content-Type", "Authorization"])

cache = TTLCache(maxsize=1024, ttl=CACHE_TTL)
HTTP = requests.Session()
HTTP.headers.update({"User-Agent": "AirAura/1.0"})

# --------------------------------------------------------------------------- ML model
MODEL, FEATURES, METRICS = None, ["PM2.5", "PM10", "NO2", "SO2", "CO", "O3"], {}
try:
    _bundle = joblib.load(BASE / "model.pkl")
    MODEL, FEATURES, METRICS = _bundle["model"], _bundle["features"], _bundle["metrics"]
except Exception as exc:  # app still runs without the model; /predict returns 503
    print(f"[warn] model.pkl not loaded: {exc}")

# Indian NAQI breakpoints mapped onto US AQI breakpoints, so the ML value (NAQI-trained)
# can be compared fairly with Open-Meteo's US AQI.
NAQI_PTS = [0, 50, 100, 200, 300, 400, 500]
US_PTS = [0, 50, 100, 150, 200, 300, 500]

NAQI_BANDS = [(50, "Good"), (100, "Satisfactory"), (200, "Moderate"), (300, "Poor"), (400, "Very Poor"), (500, "Severe")]
US_BANDS = [(50, "Good"), (100, "Moderate"), (150, "Unhealthy for Sensitive Groups"), (200, "Unhealthy"), (300, "Very Unhealthy"), (500, "Hazardous")]


def band(value, bands):
    for limit, name in bands:
        if value <= limit:
            return name
    return bands[-1][1]


# --------------------------------------------------------------------------- database
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS favorites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                country TEXT,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                UNIQUE(user_id, lat, lon)
            );
            """
        )


init_db()


# --------------------------------------------------------------------------- auth helpers
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def make_token(user_id: int) -> str:
    payload = {"sub": str(user_id), "exp": dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=7)}
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def auth_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify(error="Please log in to continue."), 401
        try:
            data = jwt.decode(header[7:], SECRET_KEY, algorithms=["HS256"])
            user = get_db().execute("SELECT id, name, email FROM users WHERE id = ?", (data["sub"],)).fetchone()
        except jwt.PyJWTError:
            return jsonify(error="Your session expired. Please log in again."), 401
        if user is None:
            return jsonify(error="Account not found. Please log in again."), 401
        g.user = user
        return fn(*args, **kwargs)

    return wrapper


@app.post("/api/auth/register")
def register():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    errors = {}
    if len(name) < 2:
        errors["name"] = "Please enter your name (at least 2 characters)."
    if not EMAIL_RE.match(email):
        errors["email"] = "Please enter a valid email address."
    if len(password) < 8:
        errors["password"] = "Password must be at least 8 characters."
    elif not (re.search(r"[A-Za-z]", password) and re.search(r"\d", password)):
        errors["password"] = "Use at least one letter and one number."
    if errors:
        return jsonify(error="Please fix the highlighted fields.", fields=errors), 400

    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
            (name, email, generate_password_hash(password), dt.datetime.now(dt.timezone.utc).isoformat()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="That email is already registered.", fields={"email": "Already registered. Try logging in."}), 409
    return jsonify(token=make_token(cur.lastrowid), user={"name": name, "email": email}), 201


@app.post("/api/auth/login")
def login():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    user = get_db().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if user is None or not check_password_hash(user["password_hash"], password):
        return jsonify(error="Incorrect email or password."), 401
    return jsonify(token=make_token(user["id"]), user={"name": user["name"], "email": user["email"]})


@app.get("/api/auth/me")
@auth_required
def me():
    return jsonify(user={"name": g.user["name"], "email": g.user["email"]})


# --------------------------------------------------------------------------- favorites
@app.get("/api/favorites")
@auth_required
def list_favorites():
    rows = get_db().execute(
        "SELECT id, name, country, lat, lon FROM favorites WHERE user_id = ? ORDER BY id DESC", (g.user["id"],)
    ).fetchall()
    return jsonify(favorites=[dict(r) for r in rows])


@app.post("/api/favorites")
@auth_required
def add_favorite():
    b = request.get_json(silent=True) or {}
    try:
        name, lat, lon = str(b["name"])[:80], round(float(b["lat"]), 3), round(float(b["lon"]), 3)
    except (KeyError, ValueError, TypeError):
        return jsonify(error="A city name and coordinates are required."), 400
    db = get_db()
    try:
        db.execute(
            "INSERT INTO favorites (user_id, name, country, lat, lon) VALUES (?, ?, ?, ?, ?)",
            (g.user["id"], name, str(b.get("country") or "")[:80], lat, lon),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="This city is already in your favorites."), 409
    return list_favorites()


@app.delete("/api/favorites/<int:fav_id>")
@auth_required
def delete_favorite(fav_id):
    db = get_db()
    db.execute("DELETE FROM favorites WHERE id = ? AND user_id = ?", (fav_id, g.user["id"]))
    db.commit()
    return list_favorites()


# --------------------------------------------------------------------------- Open-Meteo proxy (cached)
def cached_get(url: str, params: dict):
    key = (url, tuple(sorted(params.items())))
    if key in cache:
        return cache[key]
    resp = HTTP.get(url, params=params, timeout=12)
    resp.raise_for_status()
    data = resp.json()
    cache[key] = data
    return data


AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
WX_URL = "https://api.open-meteo.com/v1/forecast"
GEO_URL = "https://geocoding-api.open-meteo.com/v1/search"
AQ_VARS = "us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide,uv_index"


def parse_coords():
    try:
        lat, lon = float(request.args["lat"]), float(request.args["lon"])
    except (KeyError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return round(lat, 2), round(lon, 2)  # rounding improves cache hit rate


def predict_aqi(pollutants: dict):
    """pollutants: PM2.5, PM10, NO2, SO2, O3 in ug/m3 and CO in ug/m3 (converted to mg/m3 here)."""
    row = [float(pollutants[f]) for f in FEATURES]
    row[FEATURES.index("CO")] /= 1000.0  # Open-Meteo gives ug/m3; the dataset uses mg/m3
    naqi = float(np.clip(MODEL.predict([row])[0], 0, 500))
    us_equiv = float(np.interp(naqi, NAQI_PTS, US_PTS))
    return {
        "aqi_india": round(naqi),
        "category_india": band(naqi, NAQI_BANDS),
        "aqi_us_equiv": round(us_equiv),
        "category_us": band(us_equiv, US_BANDS),
        "model": METRICS,
    }


@app.get("/api/geocode")
def geocode():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify(results=[])
    try:
        data = cached_get(GEO_URL, {"name": q, "count": 6, "language": "en", "format": "json"})
    except requests.RequestException:
        return jsonify(error="City search is unavailable right now."), 502
    results = [
        {"name": r["name"], "admin1": r.get("admin1", ""), "country": r.get("country", ""), "lat": r["latitude"], "lon": r["longitude"]}
        for r in data.get("results", [])
    ]
    return jsonify(results=results)


@app.get("/api/air")
def air():
    coords = parse_coords()
    if not coords:
        return jsonify(error="Valid lat and lon are required."), 400
    lat, lon = coords
    try:
        aq = cached_get(AQ_URL, {"latitude": lat, "longitude": lon, "current": AQ_VARS, "timezone": "auto"})["current"]
        wx = cached_get(
            WX_URL,
            {
                "latitude": lat, "longitude": lon, "timezone": "auto",
                "current": "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code,is_day",
            },
        )["current"]
    except (requests.RequestException, KeyError):
        return jsonify(error="Live data is temporarily unavailable. Please try again shortly."), 502

    pollutants = {
        "PM2.5": aq.get("pm2_5"), "PM10": aq.get("pm10"), "NO2": aq.get("nitrogen_dioxide"),
        "SO2": aq.get("sulphur_dioxide"), "CO": aq.get("carbon_monoxide"), "O3": aq.get("ozone"),
    }
    ml = None
    if MODEL is not None and all(v is not None for v in pollutants.values()):
        ml = predict_aqi(pollutants)
    return jsonify(
        lat=lat, lon=lon, time=aq.get("time"),
        us_aqi=aq.get("us_aqi"), uv_index=aq.get("uv_index"), pollutants=pollutants,
        weather={
            "temp": wx.get("temperature_2m"), "feels_like": wx.get("apparent_temperature"),
            "humidity": wx.get("relative_humidity_2m"), "wind": wx.get("wind_speed_10m"),
            "code": wx.get("weather_code"), "is_day": wx.get("is_day"),
        },
        ml=ml,
    )


@app.get("/api/grid")
def grid():
    """3x3 grid of nearby points for the map. One Open-Meteo call for all points."""
    coords = parse_coords()
    if not coords:
        return jsonify(error="Valid lat and lon are required."), 400
    lat, lon = coords
    step = min(max(float(request.args.get("step", 0.25)), 0.05), 1.0)
    pts = [(round(lat + i * step, 3), round(lon + j * step, 3)) for i in (-1, 0, 1) for j in (-1, 0, 1)]
    try:
        data = cached_get(
            AQ_URL,
            {
                "latitude": ",".join(str(p[0]) for p in pts), "longitude": ",".join(str(p[1]) for p in pts),
                "current": "us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide", "timezone": "auto",
            },
        )
    except requests.RequestException:
        return jsonify(error="Map data is temporarily unavailable."), 502
    items = data if isinstance(data, list) else [data]
    out = []
    for (plat, plon), item in zip(pts, items):
        cur = item.get("current", {})
        out.append({
            "lat": plat, "lon": plon, "us_aqi": cur.get("us_aqi"),
            "pollutants": {"PM2.5": cur.get("pm2_5"), "PM10": cur.get("pm10"), "NO2": cur.get("nitrogen_dioxide"),
                           "O3": cur.get("ozone"), "SO2": cur.get("sulphur_dioxide"), "CO": cur.get("carbon_monoxide")},
        })
    return jsonify(points=out)


# --------------------------------------------------------------------------- prediction endpoint
@app.post("/predict")
@app.post("/api/predict")
def predict():
    if MODEL is None:
        return jsonify(error="Model not available. Run train_model.py and redeploy."), 503
    body = request.get_json(silent=True) or {}
    values = {}
    for f in FEATURES:
        try:
            v = float(body[f])
        except (KeyError, TypeError, ValueError):
            return jsonify(error=f"Missing or invalid value for {f}."), 400
        if v < 0 or v > 100000:
            return jsonify(error=f"{f} is out of range."), 400
        values[f] = v
    # Send CO in ug/m3 (same unit as the live API); it is converted internally.
    return jsonify(predict_aqi(values))


# --------------------------------------------------------------------------- health + static pages
@app.get("/health")
def health():
    return jsonify(status="ok", model_loaded=MODEL is not None)


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.after_request
def cache_headers(resp):
    # Let browsers cache static assets briefly; API responses are never cached by the browser.
    if request.path.startswith("/api") or request.path in ("/predict", "/health"):
        resp.headers["Cache-Control"] = "no-store"
    elif request.path.endswith((".js", ".css")):
        resp.headers["Cache-Control"] = "public, max-age=300"
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)), debug=os.getenv("FLASK_DEBUG") == "1")