"""Vercel entrypoint: re-exports the FastAPI app from backend/main.py.

Vercel only auto-detects an app at the repo root or in api/, not in backend/.
Render does not use this file (it runs `uvicorn backend.main:app`).
"""
from backend.main import app  # noqa: F401
