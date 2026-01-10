from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel
from typing import Dict, Optional
from datetime import datetime
from functools import lru_cache

app = FastAPI(
    title="Personal API",
    description="A robust personal API for managing personal information",
    version="1.0.0"
)

class PersonalInfo(BaseModel):
    """
    Base model for personal information
    """
    name: str
    bio: str
    current_status: str
    last_updated: datetime = datetime.now()

class StudyInfo(BaseModel):
    """
    Model for educational information
    """
    institution: str
    course: str
    year: int
    achievements: Optional[Dict[str, str]] = None

@lru_cache()
def get_personal_info() -> PersonalInfo:
    """
    Retrieves cached personal information
    
    Returns:
        PersonalInfo: Personal information object
    """
    return PersonalInfo(
        name="Your Name",
        bio="Your Bio",
        current_status="Available"
    )

@app.get("/", response_model=dict)
async def root() -> dict:
    """
    Root endpoint returning API status
    
    Returns:
        dict: API status information
    """
    return {
        "status": "online",
        "timestamp": datetime.now()
    }

@app.get("/info", response_model=PersonalInfo)
async def get_info() -> PersonalInfo:
    """
    Endpoint to retrieve personal information
    
    Returns:
        PersonalInfo: Personal information object
    """
    return get_personal_info()

@app.get("/study", response_model=StudyInfo)
async def get_study_info() -> StudyInfo:
    """
    Endpoint to retrieve study information
    
    Returns:
        StudyInfo: Study information object
    """
    return StudyInfo(
        institution="Your University",
        course="Your Course",
        year=2024,
        achievements={
            "2024": "Dean's List",
            "2023": "Best Project Award"
        }
    ) 