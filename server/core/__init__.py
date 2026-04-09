"""server.core — shared business primitives.

Contents:
- db.py: async engine + session factory (A1)
- models.py: SQLAlchemy 2.x ORM models for the business schema (A2)
- domain.py: Pydantic v2 schemas — write/read/pipeline/event DTOs (A2)
- repositories.py: async repositories for each table (A2)
- storage.py: MinIO wrapper + S3 path constants (A2)
- events.py: write_event + pg_notify plumbing (A2)

No FastAPI, no Prefect — that lives in server/api and server/flows.
"""
