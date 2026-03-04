import os

DATABASE_URL = os.getenv("DATABASE_URL")

ARGO_URL = (
"https://erddap.ifremer.fr/erddap/tabledap/ArgoFloats-index.csv?"
"platform_number,time,latitude,longitude,pressure,temperature,salinity"
)