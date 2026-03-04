import os

DATABASE_URL = os.getenv("DATABASE_URL")

# Copernicus global ocean temperature dataset (via ERDDAP mirror)
COPERNICUS_URL = (
"https://erddap.ifremer.fr/erddap/griddap/"
"GLOBAL_ANALYSISFORECAST_PHY_001_024.csv?"
"thetao[(2024-01-01T00:00:00Z)]"
"[(0.494025):1:(89.50598)]"
"[(-179.5):1:(179.5)]"
)