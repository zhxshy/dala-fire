"""Shared constants and helpers for the Dala Fire pipeline.

AI-assistance note: this file was drafted with an AI coding assistant (Claude) and reviewed by the author.
"""
import os
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"          # FIRMS Archive Download CSVs (not in git)
# pipeline outputs (not in git); DALA_INT points a step at another folder (used by 08_transfer.py)
INT = Path(os.environ["DALA_INT"]) if os.environ.get("DALA_INT") else ROOT / "data" / "interim"

RES = 0.01                            # grid step in degrees (~1.1 km N-S, ~0.65-0.85 km E-W over Kazakhstan)
SENSORS = ["MODIS_T", "MODIS_A", "VNP", "VJ1", "VJ2"]
FAMILY = {"MODIS_T": "MODIS", "MODIS_A": "MODIS", "VNP": "VIIRS", "VJ1": "VIIRS", "VJ2": "VIIRS"}


def cell_ids(lat, lon, res=RES):
    """Row/column index of the grid cell that contains each point."""
    return np.floor(lat / res).astype("int32"), np.floor(lon / res).astype("int32")
