import os

DATABASE_URL = os.getenv("DATABASE_URL")

# depth dimension is required — dataset has [time][depth][lat][lon]
# stride=10 on lat/lon keeps the response small (~500 rows)
DATA_URL = (
    "https://coastwatch.pfeg.noaa.gov/erddap/griddap/nceiErsstv5.csv"
    "?sst[(2020-01-15T00:00:00Z):1:(2023-01-15T00:00:00Z)]"
    "[(0.0):1:(0.0)]"
    "[(-88.0):10:(88.0)]"
    "[(0.0):10:(358.0)]"
)