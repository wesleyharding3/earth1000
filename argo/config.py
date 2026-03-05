import os

DATABASE_URL = os.getenv("DATABASE_URL")

# NOAA OI SST v2 — global monthly means, flat CSV, reliably hosted
# Columns: year, mon, lat, lon, sst
DATA_URL = "https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr/monthly-means/monthly_means.csv"