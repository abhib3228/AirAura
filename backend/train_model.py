"""
Train an AQI regressor on Kaggle's "Air Quality Data in India (2015-2020)".
Usage:  python train_model.py
Output: model.pkl  (model, feature order, metrics, and per-city monthly typical pollutants for the fallback estimate)
"""
import pathlib
import sys

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split

BASE = pathlib.Path(__file__).parent
DATA_PATH = BASE / "data" / "city_day.csv"
MODEL_PATH = BASE / "model.pkl"
FEATURES = ["PM2.5", "PM10", "NO2", "SO2", "CO", "O3"]  # order matters; app.py uses the same
TARGET = "AQI"

# Approximate city-centre coordinates for the dataset's cities (used only to find the nearest city for the fallback)
CITY_COORDS = {
    "Ahmedabad": (23.02, 72.57), "Aizawl": (23.73, 92.72), "Amaravati": (16.51, 80.52), "Amritsar": (31.63, 74.87),
    "Bengaluru": (12.97, 77.59), "Bhopal": (23.26, 77.41), "Brajrajnagar": (21.82, 83.92), "Chandigarh": (30.73, 76.78),
    "Chennai": (13.08, 80.27), "Coimbatore": (11.02, 76.96), "Delhi": (28.61, 77.21), "Ernakulam": (9.98, 76.28),
    "Gurugram": (28.46, 77.03), "Guwahati": (26.14, 91.74), "Hyderabad": (17.39, 78.49), "Jaipur": (26.91, 75.79),
    "Jorapokhar": (23.71, 86.41), "Kochi": (9.93, 76.27), "Kolkata": (22.57, 88.36), "Lucknow": (26.85, 80.95),
    "Mumbai": (19.08, 72.88), "Patna": (25.59, 85.14), "Shillong": (25.57, 91.88), "Talcher": (20.95, 85.22),
    "Thiruvananthapuram": (8.52, 76.94), "Visakhapatnam": (17.69, 83.22),
}


def load_and_clean() -> pd.DataFrame:
    if not DATA_PATH.exists():
        sys.exit(f"Dataset not found at {DATA_PATH}. Download city_day.csv from Kaggle first.")

    df = pd.read_csv(DATA_PATH)
    print(f"Loaded {len(df):,} rows, {df['City'].nunique()} cities")

    # The target must exist; we can't learn from rows without an AQI label.
    df = df.dropna(subset=[TARGET]).copy()

    # Fill missing pollutant values: city median first (local conditions), then global median.
    for col in FEATURES:
        df[col] = df[col].fillna(df.groupby("City")[col].transform("median"))
        df[col] = df[col].fillna(df[col].median())

    # Remove physically implausible values and clip extreme outliers at the 99.9th percentile.
    df = df[(df[FEATURES] >= 0).all(axis=1)]
    for col in FEATURES:
        df[col] = df[col].clip(upper=df[col].quantile(0.999))

    print(f"After cleaning: {len(df):,} rows")
    return df


def build_climatology(df: pd.DataFrame) -> dict:
    """Typical pollutant levels per city and calendar month, for the 'no live data' fallback."""
    df = df.copy()
    df["month"] = pd.to_datetime(df["Date"], errors="coerce").dt.month

    def pack(row):  # dataset CO is mg/m3; the app works in ug/m3
        d = {k: float(v) for k, v in row.items()}
        d["CO"] *= 1000
        return d

    clim = {}
    for city, g in df.groupby("City"):
        if city not in CITY_COORDS:
            continue
        clim[city] = {
            "lat": CITY_COORDS[city][0], "lon": CITY_COORDS[city][1],
            "all": pack(g[FEATURES].median()),
            "months": {int(m): pack(r) for m, r in g.groupby("month")[FEATURES].median().iterrows()},
        }
    print(f"Climatology built for {len(clim)} cities")
    return clim


def main():
    df = load_and_clean()
    X, y = df[FEATURES], df[TARGET]
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    # Limited depth/leaf size keeps model.pkl small enough for Render's free tier.
    candidates = {
        "RandomForest": RandomForestRegressor(
            n_estimators=150, max_depth=20, min_samples_leaf=3, n_jobs=-1, random_state=42
        ),
        "HistGradientBoosting": HistGradientBoostingRegressor(
            max_iter=400, learning_rate=0.08, random_state=42
        ),
    }

    best_name, best_model, best_r2, best_mae = None, None, -np.inf, None
    for name, model in candidates.items():
        model.fit(X_train, y_train)
        pred = model.predict(X_test)
        mae, r2 = mean_absolute_error(y_test, pred), r2_score(y_test, pred)
        print(f"{name:22s} MAE = {mae:6.2f}   R2 = {r2:.4f}")
        if r2 > best_r2:
            best_name, best_model, best_r2, best_mae = name, model, r2, mae

    print(f"\nBest model: {best_name}")
    joblib.dump(
        {
            "model": best_model,
            "features": FEATURES,
            "metrics": {"name": best_name, "mae": round(float(best_mae), 2), "r2": round(float(best_r2), 4)},
            "climatology": build_climatology(df),
        },
        MODEL_PATH,
        compress=3,
    )
    print(f"Saved -> {MODEL_PATH} ({MODEL_PATH.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()