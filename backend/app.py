import os
import json
import uuid
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, UploadFile, Form, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from azure.data.tables import TableServiceClient, TableClient
from azure.storage.blob import BlobServiceClient

app = FastAPI(title="Standalone Web Stories CMS")

# CORS setup for frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Set to specific origins in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Connect to Azurite storage emulator
AZURE_CONNECTION_STRING = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true")

# Setup clients and create resources if not exists on startup
table_service_client = TableServiceClient.from_connection_string(AZURE_CONNECTION_STRING)
stories_table_client = TableClient.from_connection_string(AZURE_CONNECTION_STRING, table_name="Stories")
media_table_client = TableClient.from_connection_string(AZURE_CONNECTION_STRING, table_name="Media")

blob_service_client = BlobServiceClient.from_connection_string(AZURE_CONNECTION_STRING)
assets_container_client = blob_service_client.get_container_client("assets")
published_container_client = blob_service_client.get_container_client("published")

@app.on_event("startup")
def startup_event():
    # Create tables
    try:
        table_service_client.create_table("Stories")
    except Exception:
        pass  # Already exists
    try:
        table_service_client.create_table("Media")
    except Exception:
        pass  # Already exists

    # Create blob containers
    try:
        assets_container_client.create_container()
    except Exception:
        pass
    try:
        published_container_client.create_container()
    except Exception:
        pass

# --- Data Models ---
class StorySavePayload(BaseModel):
    storyId: str
    title: str
    slug: str
    status: str
    story_data: dict
    content: Optional[str] = ""

# --- AMP Template HTML ---
AMP_TEMPLATE = """<!doctype html>
<html amp lang="en">
  <head>
    <meta charset="utf-8">
    <title>{title}</title>
    <meta name="viewport" content="width=device-width,minimum-scale=1,initial-scale=1">
    <link rel="canonical" href="{canonical_url}">
    <script async src="https://cdn.ampproject.org/v0.js"></script>
    <script async custom-element="amp-story" src="https://cdn.ampproject.org/v0/amp-story-1.0.js"></script>
    <style amp-boilerplate>body{{-webkit-animation:-amp-start 8s steps(1,end) 0s 1 normal both;-moz-animation:-amp-start 8s steps(1,end) 0s 1 normal both;-ms-animation:-amp-start 8s steps(1,end) 0s 1 normal both;animation:-amp-start 8s steps(1,end) 0s 1 normal both}}@-webkit-keyframes -amp-start{{from{{visibility:hidden}}to{{visibility:visible}}}}@-moz-keyframes -amp-start{{from{{visibility:hidden}}to{{visibility:visible}}}}@-ms-keyframes -amp-start{{from{{visibility:hidden}}to{{visibility:visible}}}}@keyframes -amp-start{{from{{visibility:hidden}}to{{visibility:visible}}}}</style><noscript><style amp-boilerplate>body{{-webkit-animation:none;-moz-animation:none;-ms-animation:none;animation:none}}</style></noscript>
  </head>
  <body>
    {story_markup}
  </body>
</html>
"""

# --- Stories Endpoints ---

@app.get("/api/stories")
def get_stories():
    stories = []
    try:
        entities = stories_table_client.query_entities("PartitionKey eq 'story'")
        for entity in entities:
            stories.append({
                "storyId": entity["RowKey"],
                "title": entity.get("title", ""),
                "slug": entity.get("slug", ""),
                "status": entity.get("status", ""),
                "updatedAt": entity.get("updated_at", ""),
            })
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return stories

@app.get("/api/stories/{story_id}")
def get_story(story_id: str):
    try:
        entity = stories_table_client.get_entity(partition_key="story", row_key=story_id)
        return {
            "storyId": entity["RowKey"],
            "title": entity.get("title", ""),
            "slug": entity.get("slug", ""),
            "status": entity.get("status", ""),
            "storyData": json.loads(entity.get("story_data", "{}")),
            "content": entity.get("content", ""),
        }
    except Exception:
        raise HTTPException(status_code=404, detail="Story not found")

@app.post("/api/stories/{story_id}")
def save_story(story_id: str, payload: StorySavePayload):
    try:
        # Save JSON story data to Azure Table Storage
        entity = {
            "PartitionKey": "story",
            "RowKey": story_id,
            "title": payload.title,
            "slug": payload.slug,
            "status": payload.status,
            "story_data": json.dumps(payload.story_data),
            "content": payload.content,
            "updated_at": datetime.utcnow().isoformat()
        }
        stories_table_client.upsert_entity(entity)

        # If publish, write static AMP HTML file to blob container
        if payload.status == "publish":
            blob_name = f"{payload.slug}.html"
            blob_client = published_container_client.get_blob_client(blob_name)
            
            # Form complete AMP Page
            canonical_url = f"http://127.0.0.1:10000/devstoreaccount1/published/{blob_name}"
            amp_html = AMP_TEMPLATE.format(
                title=payload.title,
                canonical_url=canonical_url,
                story_markup=payload.content
            )
            
            blob_client.upload_blob(amp_html, overwrite=True, content_settings={"content_type": "text/html"})
            
            return {
                "message": "Story published successfully", 
                "storyId": story_id,
                "link": canonical_url
            }

        return {"message": "Story saved as draft", "storyId": story_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/stories/{story_id}")
def delete_story(story_id: str):
    try:
        # Get slug first to delete published blob
        entity = stories_table_client.get_entity(partition_key="story", row_key=story_id)
        slug = entity.get("slug")
        
        stories_table_client.delete_entity(partition_key="story", row_key=story_id)
        
        if slug:
            try:
                published_container_client.delete_blob(f"{slug}.html")
            except Exception:
                pass
        return {"message": "Story deleted"}
    except Exception:
        raise HTTPException(status_code=404, detail="Story not found")

# --- Media Endpoints ---

@app.get("/api/media")
def get_media(
    type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    page: int = Query(1)
):
    items = []
    try:
        entities = media_table_client.query_entities("PartitionKey eq 'media'")
        for entity in entities:
            # Simple manual filter for demo/local project
            mime_type = entity.get("mime_type", "")
            if type and type not in mime_type:
                continue
            
            # Simple search filter
            source_url = entity.get("source_url", "")
            alt_text = entity.get("alt_text", "")
            if search and (search.lower() not in source_url.lower() and search.lower() not in alt_text.lower()):
                continue

            media_details = json.loads(entity.get("media_details", "{}"))
            meta = json.loads(entity.get("meta", "{}"))

            items.append({
                "id": entity["RowKey"],
                "date_gmt": entity.get("created_at", ""),
                "mime_type": mime_type,
                "source_url": source_url,
                "alt_text": alt_text,
                "media_details": media_details,
                "meta": meta
            })
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Paginate (50 per page as requested by Google's getMedia)
    per_page = 50
    total_items = len(items)
    total_pages = (total_items + per_page - 1) // per_page
    start_idx = (page - 1) * per_page
    end_idx = start_idx + per_page
    
    paginated_items = items[start_idx:end_idx]

    return {
        "items": paginated_items,
        "totalItems": total_items,
        "totalPages": total_pages
    }

@app.post("/api/media")
async def upload_media(
    file: UploadFile,
    additional_data: str = Form("{}")
):
    try:
        media_id = str(uuid.uuid4())
        file_ext = os.path.splitext(file.filename)[1]
        blob_name = f"{media_id}{file_ext}"

        # 1. Upload to Azure Blob Storage
        blob_client = assets_container_client.get_blob_client(blob_name)
        content = await file.read()
        blob_client.upload_blob(content, overwrite=True)
        source_url = blob_client.url

        # Parsed additional details
        additional_info = json.loads(additional_data)

        # 2. Build WordPress compatibility structure
        media_details = {
            "width": additional_info.get("width", 1080),
            "height": additional_info.get("height", 1920),
            "sizes": {}
        }
        
        meta = {
            "web_stories_base_color": additional_info.get("baseColor"),
            "web_stories_blurhash": additional_info.get("blurHash")
        }

        # 3. Save to Table Storage
        entity = {
            "PartitionKey": "media",
            "RowKey": media_id,
            "mime_type": file.content_type,
            "source_url": source_url,
            "alt_text": additional_info.get("altText", ""),
            "media_details": json.dumps(media_details),
            "meta": json.dumps(meta),
            "created_at": datetime.utcnow().isoformat()
        }
        media_table_client.upsert_entity(entity)

        return {
            "id": media_id,
            "date_gmt": entity["created_at"],
            "mime_type": file.content_type,
            "source_url": source_url,
            "alt_text": entity["alt_text"],
            "media_details": media_details,
            "meta": meta
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/media/{media_id}")
def delete_media(media_id: str):
    try:
        entity = media_table_client.get_entity(partition_key="media", row_key=media_id)
        source_url = entity.get("source_url", "")
        
        # Extract filename from URL
        if source_url:
            blob_name = source_url.split("/")[-1]
            try:
                assets_container_client.delete_blob(blob_name)
            except Exception:
                pass

        media_table_client.delete_entity(partition_key="media", row_key=media_id)
        return {"message": "Media deleted"}
    except Exception:
        raise HTTPException(status_code=404, detail="Media not found")

# --- Fonts Endpoints ---

@app.get("/api/fonts")
def get_fonts():
    # Return a basic catalog of standard Google Fonts to use in editor with expected variants
    popular_fonts = [
        {
            "family": "Roboto",
            "fallbacks": ["sans-serif"],
            "weights": [300, 400, 500, 700],
            "styles": ["normal", "italic"],
            "variants": [[0, 300], [0, 400], [0, 500], [0, 700], [1, 300], [1, 400], [1, 500], [1, 700]],
            "service": "google"
        },
        {
            "family": "Open Sans",
            "fallbacks": ["sans-serif"],
            "weights": [300, 400, 600, 700],
            "styles": ["normal", "italic"],
            "variants": [[0, 300], [0, 400], [0, 600], [0, 700], [1, 300], [1, 400], [1, 600], [1, 700]],
            "service": "google"
        },
        {
            "family": "Montserrat",
            "fallbacks": ["sans-serif"],
            "weights": [400, 500, 700],
            "styles": ["normal"],
            "variants": [[0, 400], [0, 500], [0, 700]],
            "service": "google"
        },
        {
            "family": "Lato",
            "fallbacks": ["sans-serif"],
            "weights": [300, 400, 700],
            "styles": ["normal", "italic"],
            "variants": [[0, 300], [0, 400], [0, 700], [1, 300], [1, 400], [1, 700]],
            "service": "google"
        },
        {
            "family": "Poppins",
            "fallbacks": ["sans-serif"],
            "weights": [300, 400, 500, 600, 700],
            "styles": ["normal"],
            "variants": [[0, 300], [0, 400], [0, 500], [0, 600], [0, 700]],
            "service": "google"
        },
        {
            "family": "Playfair Display",
            "fallbacks": ["serif"],
            "weights": [400, 700],
            "styles": ["normal", "italic"],
            "variants": [[0, 400], [0, 700], [1, 400], [1, 700]],
            "service": "google"
        },
        {
            "family": "Merriweather",
            "fallbacks": ["serif"],
            "weights": [300, 400, 700],
            "styles": ["normal"],
            "variants": [[0, 300], [0, 400], [0, 700]],
            "service": "google"
        }
    ]
    return popular_fonts

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
