"""
Train an AQI regressor on Kaggle's "Air Quality Data in India (2015-2020)".
Usage:  python train_model.py
Output: model.pkl  (dict with the model, feature order, and metrics)
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
        },
        MODEL_PATH,
        compress=3,
    )
    print(f"Saved -> {MODEL_PATH} ({MODEL_PATH.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()