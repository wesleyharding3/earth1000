import os

DATABASE_URL = os.getenv("DATABASE_URL")

ARGO_URL = (
"https://erddap.ucsd.edu/erddap/tabledap/ArgoFloats.csv?"
"platform_number,time,latitude,longitude,pressure,temperature,salinity"
)