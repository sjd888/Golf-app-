export interface Hole {
  p: number; // Par
  idx: number; // Index/Handicap
}

export interface Course {
  name: string;
  holes: Hole[];
}

export interface Shot {
  dist: number;
  time: number;
  pos?: { lat: number; lon: number };
}

export interface HoleMetric {
  meters: number;
  time: number;
  shots: Shot[];
}

export interface Player {
  name: string;
  hcp: number;
  scores: (number | null)[];
  strokeScores: (number | null)[];
  tempScore: number;
  metrics: HoleMetric[];
  uid?: string;
}

export interface RoundHistory {
  name: string;
  players: string[];
}

export type ScoringType = 'stableford' | 'stroke';

export interface Game {
  id?: string;
  name: string;
  courseName: string;
  courseHoles: Hole[];
  players: (Player & { uid?: string })[];
  hole: number;
  status: 'active' | 'finished';
  scoringType: ScoringType;
  createdAt: any;
  createdBy: string;
}

export interface AppState {
  players: Player[];
  customCourses: Course[];
  curIdx: number;
  hole: number;
  scoringType: ScoringType;
  theme: 'dark' | 'light';
  totalMeters: number;
  isMarked: boolean;
  markPos: { lat: number; lon: number } | null;
  history: RoundHistory[];
  startTime: number | null;
  holeStartTime: number | null;
  shotStartTime: number | null;
  currentGameId: string | null;
}

export interface Position {
  lat: number;
  lon: number;
}
