import { Course, Hole } from "../types";

const BASE_URL = "https://golfapi.io/api/v1";
const API_KEY = (import.meta as any).env.VITE_GOLF_API_KEY;

export interface GolfApiClub {
  id: string;
  name: string;
  city: string;
  country: string;
  courses?: GolfApiCourse[];
}

export interface GolfApiCourse {
  id: string;
  name: string;
  holes?: {
    number: number;
    par: number;
    handicap: number;
  }[];
}

export const searchClubs = async (query: string): Promise<GolfApiClub[]> => {
  if (!API_KEY) {
    console.warn("GOLF_API_KEY is not set. Please add it to your environment variables.");
    return [];
  }

  try {
    const response = await fetch(`${BASE_URL}/clubs?name=${encodeURIComponent(query)}`, {
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Golf API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.clubs || [];
  } catch (error) {
    console.error("Error searching clubs:", error);
    return [];
  }
};

export const getClubDetails = async (clubId: string): Promise<GolfApiClub | null> => {
  if (!API_KEY) return null;

  try {
    const response = await fetch(`${BASE_URL}/clubs/${clubId}`, {
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Golf API error: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Error fetching club details:", error);
    return null;
  }
};

export const getCourseDetails = async (courseId: string): Promise<Course | null> => {
  if (!API_KEY) return null;

  try {
    const response = await fetch(`${BASE_URL}/courses/${courseId}`, {
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Golf API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Map GolfAPI format to our Course format
    if (data && data.holes) {
      const holes: Hole[] = data.holes.map((h: any) => ({
        p: h.par,
        idx: h.handicap
      }));

      return {
        name: data.name,
        holes
      };
    }

    return null;
  } catch (error) {
    console.error("Error fetching course details:", error);
    return null;
  }
};
