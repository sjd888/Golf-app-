import React, { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  PlayCircle, 
  ListOrdered, 
  BarChart3, 
  Settings2, 
  ChevronLeft, 
  ChevronRight, 
  Plus, 
  Trash2, 
  CheckCircle2, 
  AlertCircle,
  MapPin,
  History,
  Download,
  RotateCcw,
  Search,
  Globe,
  Loader2,
  QrCode
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger,
  DialogFooter,
  DialogClose
} from "@/components/ui/dialog";
import { useGeolocation, calculateDistance } from "./hooks/useGeolocation";
import { COURSES } from "./constants";
import { 
  Users,
  LogOut,
  LogIn,
  Trophy,
  Copy,
  UserPlus,
  Sun,
  Moon
} from "lucide-react";
import { 
  auth, 
  db, 
  googleProvider, 
  handleFirestoreError, 
  OperationType 
} from "./lib/firebase";
import { 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  User as FirebaseUser 
} from "firebase/auth";
import { 
  doc, 
  setDoc, 
  onSnapshot, 
  collection, 
  addDoc, 
  updateDoc, 
  serverTimestamp, 
  query, 
  where,
  getDocs
} from "firebase/firestore";
import { AppState, Player, HoleMetric, RoundHistory, Course, Hole, Game } from "./types";
import { cn } from "@/lib/utils";
import { searchClubs, getClubDetails, getCourseDetails, GolfApiClub, GolfApiCourse } from "./services/golfApiService";

const STORAGE_KEY = "darcy_golf_v14";

const initialAppState: AppState = {
  players: [],
  customCourses: [],
  curIdx: -1,
  hole: 1,
  scoringType: 'stableford',
  theme: 'dark',
  totalMeters: 0,
  isMarked: false,
  markPos: null,
  history: [],
  startTime: null,
  holeStartTime: null,
  shotStartTime: null,
  currentGameId: null,
};

export default function App() {
  const [selectedPlayerIndex, setSelectedPlayerIndex] = useState<number | null>(null);
  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return { ...initialAppState, ...parsed };
      } catch (e) {
        console.error("Failed to parse saved state", e);
        return initialAppState;
      }
    }
    return initialAppState;
  });
  const [activeTab, setActiveTab] = useState("setup");
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [availableGames, setAvailableGames] = useState<Game[]>([]);
  const { position: livePos, error: gpsError } = useGeolocation();

  // Auth Listener
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        // Sync user profile
        setDoc(doc(db, "users", u.uid), {
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          role: "user"
        }, { merge: true });
      }
    });
  }, []);

  // Real-time Game Sync
  useEffect(() => {
    if (!state.currentGameId) return;

    const unsub = onSnapshot(doc(db, "games", state.currentGameId), (snapshot) => {
      if (snapshot.exists()) {
        const gameData = snapshot.data() as Game;
        // Only update if we are not the one who just updated (to avoid local lag)
        // Actually, for simplicity, we sync everything except local GPS state
        updateState({
          players: gameData.players,
          hole: gameData.hole,
          // We don't sync metrics/totalMeters yet as they are personal
        });
      }
    }, (err) => handleFirestoreError(err, OperationType.GET, `games/${state.currentGameId}`));

    return () => unsub();
  }, [state.currentGameId]);

  // Available Games Listener
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "games"), where("status", "==", "active"));
    const unsub = onSnapshot(q, (snapshot) => {
      const games = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Game));
      setAvailableGames(games);
    });
    return () => unsub();
  }, [user]);

  const login = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Login failed", err);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      updateState({ currentGameId: null });
    } catch (err) {
      console.error("Logout failed", err);
    }
  };

  const createGame = async (courseIdx: number, gameName: string) => {
    if (!user) return;
    haptic([30, 30]);
    const course = allCourses[courseIdx];
    const newGame: Omit<Game, 'id'> = {
      name: gameName,
      courseName: course.name,
      courseHoles: course.holes,
      players: state.players.map(p => ({ ...p, uid: user.uid })),
      hole: 1,
      status: 'active',
      scoringType: state.scoringType,
      createdAt: serverTimestamp(),
      createdBy: user.uid
    };

    try {
      const docRef = await addDoc(collection(db, "games"), newGame);
      updateState({ 
        currentGameId: docRef.id,
        curIdx: courseIdx,
        hole: 1,
        scoringType: state.scoringType,
        startTime: Date.now(),
        holeStartTime: Date.now()
      });
      setActiveTab("play");
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "games");
    }
  };

  const joinGame = async (gameId: string) => {
    if (!user) return;
    haptic([30, 30]);
    const game = availableGames.find(g => g.id === gameId);
    if (!game) return;

    // Check if player already in game
    const isAlreadyIn = game.players.some(p => p.uid === user.uid);
    let newPlayers = [...game.players];
    
    if (!isAlreadyIn) {
      newPlayers.push({
        name: user.displayName || "Guest",
        hcp: 18, // Default
        scores: Array(18).fill(null),
        strokeScores: Array(18).fill(null),
        tempScore: 0,
        metrics: Array(18).fill(null).map(() => ({ meters: 0, time: 0, shots: [] })),
        uid: user.uid
      });
    }

    try {
      await updateDoc(doc(db, "games", gameId), { players: newPlayers });
      
      // Find course index
      const courseIdx = allCourses.findIndex(c => c.name === game.courseName);
      
      updateState({ 
        currentGameId: gameId,
        curIdx: courseIdx !== -1 ? courseIdx : 0,
        players: newPlayers,
        hole: game.hole,
        scoringType: game.scoringType,
        startTime: Date.now(),
        holeStartTime: Date.now()
      });
      setActiveTab("play");
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `games/${gameId}`);
    }
  };

  const getScoreTerm = (score: number, par: number) => {
    if (score === 0) return "";
    const diff = score - par;
    if (score === 1) return "HOLE IN ONE";
    if (diff === -3) return "ALBATROSS";
    if (diff === -2) return "EAGLE";
    if (diff === -1) return "BIRDIE";
    if (diff === 0) return "PAR";
    if (diff === 1) return "BOGEY";
    if (diff === 2) return "DBL BOGEY";
    if (diff === 3) return "TRP BOGEY";
    return `${diff > 0 ? '+' : ''}${diff}`;
  };

  const getScoreColor = (score: number, par: number) => {
    if (score === 0) return "text-zinc-500";
    const diff = score - par;
    if (diff < 0) return "text-red-400"; // Under par
    if (diff === 0) return "text-white"; // Par
    return "text-blue-400"; // Over par
  };

  // Save state to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  // Apply Theme
  useEffect(() => {
    if (state.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [state.theme]);

  const updateState = useCallback((updates: Partial<AppState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  }, []);

  const haptic = useCallback((pattern: number | number[] = 10) => {
    if (typeof window !== 'undefined' && window.navigator && window.navigator.vibrate) {
      window.navigator.vibrate(pattern);
    }
  }, []);

  const syncGameUpdate = useCallback(async (updates: Partial<Game>) => {
    if (!state.currentGameId) return;
    try {
      await updateDoc(doc(db, "games", state.currentGameId), updates);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `games/${state.currentGameId}`);
    }
  }, [state.currentGameId]);

  // Debounced sync for rapid updates (like score adjustments)
  const debouncedSync = useRef<NodeJS.Timeout | null>(null);
  const syncGameUpdateDebounced = useCallback((updates: Partial<Game>) => {
    if (debouncedSync.current) clearTimeout(debouncedSync.current);
    debouncedSync.current = setTimeout(() => {
      syncGameUpdate(updates);
    }, 1000);
  }, [syncGameUpdate]);

  const allCourses = [...COURSES, ...state.customCourses];

  const addPlayer = (name: string, hcp: number) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const newPlayer: Player = {
      name: trimmedName,
      hcp: isNaN(hcp) ? 0 : hcp,
      scores: Array(18).fill(null),
      strokeScores: Array(18).fill(null),
      tempScore: 0,
      metrics: Array(18).fill(null).map(() => ({ meters: 0, time: 0, shots: [] })),
    };
    updateState({ players: [...state.players, newPlayer] });
  };

  const removePlayer = (index: number) => {
    const newPlayers = [...state.players];
    newPlayers.splice(index, 1);
    updateState({ players: newPlayers });
  };

  const editPlayer = (index: number, name: string, hcp: number) => {
    const newPlayers = [...state.players];
    newPlayers[index] = { ...newPlayers[index], name, hcp };
    updateState({ players: newPlayers });
    if (state.currentGameId) {
      syncGameUpdateDebounced({ players: newPlayers });
    }
  };

  const handleMark = () => {
    if (!livePos) return;
    haptic(30);
    updateState({
      markPos: { ...livePos },
      shotStartTime: Date.now(),
      isMarked: true,
    });
  };

  const handleMeasure = () => {
    if (!state.isMarked || !livePos || !state.markPos) return;
    haptic([40, 20, 40]);
    const dist = calculateDistance(state.markPos, livePos);
    const shotTime = state.shotStartTime ? Math.floor((Date.now() - state.shotStartTime) / 1000) : 0;
    
    const newPlayers = state.players.map((p, idx) => {
      // If multiplayer, only update the current user's score
      const isCurrentUser = (user && p.uid === user.uid) || (!user && idx === 0);
      if (isCurrentUser) {
        const updatedMetrics = [...p.metrics];
        if (!updatedMetrics[state.hole - 1]) {
          updatedMetrics[state.hole - 1] = { meters: 0, time: 0, shots: [] };
        }
        updatedMetrics[state.hole - 1].shots.push({ 
          dist, 
          time: shotTime, 
          pos: { ...livePos } 
        });
        return { ...p, tempScore: p.tempScore + 1, metrics: updatedMetrics };
      }
      return p;
    });

    updateState({
      totalMeters: state.totalMeters + dist,
      isMarked: false,
      players: newPlayers,
    });

    if (state.currentGameId) {
      syncGameUpdateDebounced({ players: newPlayers });
    }
  };

  const finishHole = () => {
    if (state.curIdx === -1) return;
    haptic([50, 30, 50]);
    const course = allCourses[state.curIdx];
    const holeData = course.holes[state.hole - 1];
    const hTime = state.holeStartTime ? Math.floor((Date.now() - state.holeStartTime) / 1000) : 0;
    
    const newPlayers = state.players.map((p, idx) => {
      const isCurrentUser = (user && p.uid === user.uid) || (!user && idx === 0);
      
      const strokes = Math.floor(p.hcp / 18) + (holeData.idx <= (p.hcp % 18) ? 1 : 0);
      const stablefordPoints = p.tempScore > 0 
        ? Math.max(0, (holeData.p + 2) - (p.tempScore - strokes)) 
        : 0;
      
      const newScores = [...p.scores];
      newScores[state.hole - 1] = stablefordPoints;

      const newStrokeScores = [...(p.strokeScores || Array(18).fill(null))];
      newStrokeScores[state.hole - 1] = p.tempScore;
      
      const updatedMetrics = [...p.metrics];
      if (isCurrentUser) {
        if (!updatedMetrics[state.hole - 1]) {
          updatedMetrics[state.hole - 1] = { meters: 0, time: 0, shots: [] };
        }
        updatedMetrics[state.hole - 1].meters = state.totalMeters;
        updatedMetrics[state.hole - 1].time = hTime;
      }
      
      return { ...p, scores: newScores, strokeScores: newStrokeScores, tempScore: 0, metrics: updatedMetrics };
    });

    if (state.hole < 18) {
      const nextHole = state.hole + 1;
      updateState({
        players: newPlayers,
        totalMeters: 0,
        isMarked: false,
        hole: nextHole,
        holeStartTime: Date.now(),
      });
      if (state.currentGameId) {
        syncGameUpdate({ players: newPlayers, hole: nextHole });
      }
    } else {
      updateState({
        players: newPlayers,
        totalMeters: 0,
        isMarked: false,
      });
      if (state.currentGameId) {
        syncGameUpdate({ players: newPlayers, status: 'finished' });
      }
      setActiveTab("score");
    }
  };

  const handleMainAction = () => {
    haptic(40);
    if (state.hole === 18) {
      finishHole();
      setActiveTab("score");
    } else {
      finishHole();
    }
  };

  const archiveRound = () => {
    if (state.curIdx === -1) return;
    haptic([100, 50, 100]);
    const now = new Date();
    const stamp = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')} ${now.toLocaleDateString()} - ${allCourses[state.curIdx].name}`;
    
    const newHistory: RoundHistory = {
      name: stamp,
      players: state.players.map(p => `${p.name}: ${p.scores.reduce((a, b) => a + (b || 0), 0)}`),
    };

    updateState({
      history: [...state.history, newHistory],
      curIdx: -1,
      players: [],
      hole: 1,
      totalMeters: 0,
      isMarked: false,
      markPos: null,
      startTime: null,
      holeStartTime: null,
      shotStartTime: null,
    });
    setActiveTab("setup");
  };

  const exportKML = () => {
    const colors = [
      'ff0000ff', // Red
      'ff00ff00', // Green
      'ffff0000', // Blue
      'ff00ffff', // Yellow
      'ffff00ff', // Purple
      'ffffff00', // Cyan
    ];

    let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Golf Round - ${allCourses[state.curIdx]?.name || 'Unknown'}</name>
`;

    state.players.forEach((player, pIdx) => {
      const color = colors[pIdx % colors.length];
      kml += `    <Style id="player${pIdx}">
      <LineStyle>
        <color>${color}</color>
        <width>4</width>
      </LineStyle>
      <IconStyle>
        <color>${color}</color>
        <scale>1.1</scale>
      </IconStyle>
    </Style>
    <Folder>
      <name>${player.name}</name>
`;

      player.metrics.forEach((metric, hIdx) => {
        if (metric.shots.length > 0) {
          kml += `      <Placemark>
        <name>${player.name} - Hole ${hIdx + 1}</name>
        <styleUrl>#player${pIdx}</styleUrl>
        <LineString>
          <tessellate>1</tessellate>
          <coordinates>
`;
          metric.shots.forEach(shot => {
            if (shot.pos) {
              kml += `            ${shot.pos.lon},${shot.pos.lat},0\n`;
            }
          });
          kml += `          </coordinates>
        </LineString>
      </Placemark>
`;
          
          metric.shots.forEach((shot, sIdx) => {
            if (shot.pos) {
              kml += `      <Placemark>
        <name>${player.name} - H${hIdx + 1} S${sIdx + 1}</name>
        <styleUrl>#player${pIdx}</styleUrl>
        <Point>
          <coordinates>${shot.pos.lon},${shot.pos.lat},0</coordinates>
        </Point>
      </Placemark>
`;
            }
          });
        }
      });

      kml += `    </Folder>\n`;
    });

    kml += `  </Document>\n</kml>`;

    haptic([20, 50, 20]);
    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `golf_round_${new Date().getTime()}.kml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportCSV = () => {
    const course = allCourses[state.curIdx];
    if (!course) return;

    let csv = "Player,Hole,Par,Stroke Index,Score (Points),Strokes (Temp),Distance (m),Time (s),Longest Drive (m)\n";

    state.players.forEach(player => {
      player.scores.forEach((score, hIdx) => {
        const hole = hIdx + 1;
        const par = course.holes[hIdx].p;
        const si = course.holes[hIdx].idx;
        const metric = player.metrics[hIdx];
        const dist = metric?.meters || 0;
        const time = metric?.time || 0;
        const longestDrive = metric?.shots?.[0]?.dist || 0;
        
        csv += `"${player.name}",${hole},${par},${si},${score || 0},${player.tempScore},${dist},${time},${longestDrive}\n`;
      });
    });

    csv += "\nRound Summary\n";
    csv += "Player,Total Points,Total Strokes,Avg Distance (m),Avg Time (s),Longest Drive (m)\n";
    state.players.forEach(player => {
      const totalPoints = player.scores.reduce((a, b) => a + (b || 0), 0);
      const totalStrokes = player.scores.length; // Simplified for now
      let totalDist = 0;
      let totalTime = 0;
      let maxDrive = 0;
      let holesPlayed = 0;

      player.metrics.forEach(m => {
        if (m.meters > 0) {
          totalDist += m.meters;
          totalTime += m.time;
          holesPlayed++;
        }
        if (m.shots?.[0]?.dist) {
          maxDrive = Math.max(maxDrive, m.shots[0].dist);
        }
      });

      const avgDist = holesPlayed > 0 ? (totalDist / holesPlayed).toFixed(2) : 0;
      const avgTime = holesPlayed > 0 ? (totalTime / holesPlayed).toFixed(2) : 0;

      csv += `"${player.name}",${totalPoints},${totalStrokes},${avgDist},${avgTime},${maxDrive}\n`;
    });

    haptic([20, 50, 20]);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `golf_analytics_${new Date().getTime()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const [showResetDialog, setShowResetDialog] = useState(false);

  const resetApp = () => {
    setState(initialAppState);
    setActiveTab("setup");
    setShowResetDialog(false);
  };

  const adjustScore = (playerIdx: number, val: number) => {
    haptic(15);
    const newPlayers = [...state.players];
    newPlayers[playerIdx].tempScore = Math.max(0, newPlayers[playerIdx].tempScore + val);
    updateState({ players: newPlayers });
    if (state.currentGameId) {
      syncGameUpdateDebounced({ players: newPlayers });
    }
  };

  const selectCourse = (idx: number) => {
    haptic([30, 30]);
    updateState({
      curIdx: idx,
      hole: 1,
      startTime: Date.now(),
      holeStartTime: Date.now(),
    });
    setActiveTab("play");
  };

  return (
    <div className="flex flex-col min-h-screen pb-24 max-w-md mx-auto px-4 pt-4 bg-background text-foreground">
      <AnimatePresence mode="wait">
        {activeTab === "play" && (
          <motion.div
            key="play"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="space-y-4"
          >
            <div className="text-center">
              <div className="text-blue-accent font-bold text-xs uppercase tracking-widest mb-1">
                {state.curIdx !== -1 ? allCourses[state.curIdx].name : "NO COURSE SELECTED"}
              </div>
              <div className="flex justify-between items-center">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="rounded-full bg-card"
                  onClick={() => updateState({ hole: Math.max(1, state.hole - 1) })}
                >
                  <ChevronLeft className="w-6 h-6" />
                </Button>
                <div className="text-center">
                  <h2 className="text-2xl font-black text-neon">HOLE {state.hole}</h2>
                  <p className="text-xs text-muted-foreground font-mono uppercase">
                    {state.curIdx !== -1 ? (
                      `PAR ${allCourses[state.curIdx].holes[state.hole - 1].p} | INDEX ${allCourses[state.curIdx].holes[state.hole - 1].idx}`
                    ) : "PAR - | INDEX -"}
                  </p>
                </div>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="rounded-full bg-card"
                  onClick={() => updateState({ hole: Math.min(18, state.hole + 1) })}
                >
                  <ChevronRight className="w-6 h-6" />
                </Button>
              </div>
            </div>

            <Card className="bg-card border-border rounded-[30px] overflow-hidden">
              <CardContent className="p-6 text-center space-y-4">
                <div className="flex items-center justify-center gap-2">
                  {gpsError ? (
                    <span className="text-red-500 text-xs flex items-center gap-1 font-mono">
                      <AlertCircle className="w-3 h-3" /> GPS ERROR: {gpsError.toUpperCase()}
                    </span>
                  ) : livePos ? (
                    <span className="text-neon text-xs flex items-center gap-1 font-mono">
                      <CheckCircle2 className="w-3 h-3" /> GPS READY
                    </span>
                  ) : (
                    <span className="text-yellow-500 text-xs flex items-center gap-1 animate-pulse font-mono">
                      <MapPin className="w-3 h-3" /> INITIALIZING GPS...
                    </span>
                  )}
                </div>
                
                <div className="dist-txt text-foreground">
                  {Math.round(state.totalMeters)}<span className="text-2xl ml-1 text-muted-foreground">m</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Button
                    className={cn(
                      "h-20 text-lg font-black rounded-2xl transition-all duration-300",
                      state.isMarked 
                        ? "bg-neon text-black shadow-[0_0_20px_rgba(0,255,136,0.4)]" 
                        : "bg-zinc-800 text-white hover:bg-zinc-700"
                    )}
                    onClick={handleMark}
                  >
                    MARK
                  </Button>
                  <Button
                    disabled={!state.isMarked}
                    className="h-20 text-lg font-black rounded-2xl bg-zinc-800 text-white hover:bg-zinc-700 disabled:opacity-30"
                    onClick={handleMeasure}
                  >
                    MEASURE
                  </Button>
                </div>

                {state.players.length > 0 && state.players[0].tempScore > 0 && (
                  <Button 
                    variant="destructive" 
                    className="w-full py-6 font-bold rounded-2xl"
                    onClick={finishHole}
                  >
                    {state.scoringType === 'stableford' ? "PICK UP (0 PTS)" : "PICK UP (MAX SCORE)"}
                  </Button>
                )}
              </CardContent>
            </Card>

            <div className="space-y-3">
              {state.players.map((p, i) => {
                const holeData = state.curIdx !== -1 ? allCourses[state.curIdx].holes[state.hole - 1] : null;
                const strokes = holeData ? (Math.floor(p.hcp / 18) + (holeData.idx <= (p.hcp % 18) ? 1 : 0)) : 0;
                const pts = holeData && p.tempScore > 0 
                  ? Math.max(0, (holeData.p + 2) - (p.tempScore - strokes)) 
                  : 0;

                return (
                  <Card key={i} className={cn(
                    "bg-muted/50 border-l-4 border-y-0 border-r-0 rounded-2xl overflow-hidden",
                    state.scoringType === 'stableford' ? "border-l-neon" : "border-l-blue-accent"
                  )}>
                    <CardContent className="p-4 flex justify-between items-center">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-foreground">{p.name}</span>
                          <Badge variant="secondary" className="bg-muted text-[10px] text-muted-foreground border-none">
                            +{strokes} Strokes
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4">
                          <Button 
                            variant="secondary" 
                            size="icon" 
                            className="w-10 h-10 rounded-xl bg-muted"
                            onClick={() => adjustScore(i, -1)}
                          >
                            -
                          </Button>
                          <span className="text-3xl font-black min-w-[2ch] text-center">{p.tempScore}</span>
                          <Button 
                            variant="secondary" 
                            size="icon" 
                            className="w-10 h-10 rounded-xl bg-muted"
                            onClick={() => adjustScore(i, 1)}
                          >
                            +
                          </Button>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] text-muted-foreground font-bold uppercase">
                          {state.scoringType === 'stableford' ? "Points" : "Strokes"}
                        </div>
                        <div className={cn(
                          "text-2xl font-black",
                          state.scoringType === 'stableford' ? "text-neon" : "text-blue-accent"
                        )}>
                          {state.scoringType === 'stableford' ? pts : p.tempScore}
                        </div>
                        <div className={cn("text-[10px] font-bold uppercase", getScoreColor(p.tempScore, holeData?.p || 0))}>
                          {holeData ? getScoreTerm(p.tempScore, holeData.p) : ""}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            <Button 
              className="w-full py-8 text-xl font-black rounded-2xl bg-neon text-black hover:bg-neon/90"
              onClick={handleMainAction}
            >
              {state.hole === 18 ? "FINISH ROUND" : "SAVE & NEXT HOLE"}
            </Button>
          </motion.div>
        )}

        {activeTab === "score" && (
          <motion.div
            key="score"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="space-y-6"
          >
            <div className="flex justify-between items-center">
              <h2 className="text-3xl font-black italic">SCOREBOARD</h2>
              {state.players.length > 0 && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="border-neon text-neon hover:bg-neon hover:text-black rounded-xl"
                  onClick={exportKML}
                >
                  <Download className="w-4 h-4 mr-2" /> EXPORT KML
                </Button>
              )}
            </div>
            <div className="space-y-4">
              {state.players.map((p, i) => (
                <Card key={i} className="bg-card border-zinc-800 rounded-[30px]">
                  <CardHeader className="pb-2">
                    <CardTitle 
                      className="text-neon text-sm font-black tracking-widest uppercase cursor-pointer hover:underline flex items-center gap-2"
                      onClick={() => {
                        haptic(10);
                        setSelectedPlayerIndex(i);
                      }}
                    >
                      {p.name}
                      <Badge variant="outline" className="text-[8px] h-4 border-neon/30 text-neon/50 font-mono">VIEW CARD</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-9 gap-1.5">
                      {p.scores.map((s, idx) => (
                        <div 
                          key={idx} 
                          className={cn(
                            "relative aspect-square flex items-center justify-center rounded-md text-[10px] font-bold transition-all duration-300",
                            s !== null 
                              ? "bg-neon text-black shadow-[0_0_10px_rgba(0,255,136,0.3)]" 
                              : "bg-muted/50 text-muted-foreground/30 border border-border/50"
                          )}
                        >
                          <span className={cn(
                            "absolute top-0.5 left-1 text-[6px] font-black tracking-tighter",
                            s !== null ? "text-black/40" : "text-muted-foreground/40"
                          )}>
                            {idx + 1}
                          </span>
                          <span className={s !== null ? "scale-110" : "scale-100"}>
                            {s !== null ? s : "-"}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex justify-between items-end">
                      <span className="text-xs text-muted-foreground font-bold uppercase">
                        {state.scoringType === 'stableford' ? "Total Points" : "Total Strokes"}
                      </span>
                      <span className="text-2xl font-black">
                        {p.scores.reduce((a, b) => a + (b || 0), 0)} {state.scoringType === 'stableford' ? "PTS" : "STR"}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </motion.div>
        )}

        {activeTab === "data" && (
          <motion.div
            key="data"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="space-y-6"
          >
            <div className="flex justify-between items-center">
              <h2 className="text-3xl font-black italic">DATA</h2>
              {state.players.length > 0 && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="border-neon text-neon hover:bg-neon hover:text-black rounded-xl"
                  onClick={exportCSV}
                >
                  <Download className="w-4 h-4 mr-2" /> EXPORT CSV
                </Button>
              )}
            </div>
            
            {(() => {
              const currentPlayer = state.players.find(p => p.uid === user?.uid) || state.players[0];
              const metrics = currentPlayer?.metrics || [];
              
              return (
                <>
                  <Card className="bg-card border-border rounded-[30px]">
                    <CardContent className="p-6 space-y-4">
                      <div className="flex justify-between items-center border-b border-border pb-3">
                        <span className="text-muted-foreground text-sm">Round Time</span>
                        <span className="font-black">
                          {(() => {
                            const totalTime = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
                            return `${Math.floor(totalTime / 60)}m ${totalTime % 60}s`;
                          })()}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground text-sm">Longest Drive ({currentPlayer?.name || 'Me'})</span>
                        <span className="font-black text-neon">
                          {(() => {
                            let longest = 0;
                            metrics.forEach(h => {
                              if (h.shots && h.shots.length > 0) {
                                longest = Math.max(longest, h.shots[0].dist);
                              }
                            });
                            return `${Math.round(longest)}m`;
                          })()}
                        </span>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="bg-card border-border rounded-[30px]">
                    <CardHeader>
                      <CardTitle className="text-blue-accent text-sm font-black uppercase tracking-widest">Stroke Play Stats ({currentPlayer?.name || 'Me'})</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-muted/50 p-4 rounded-2xl border border-border">
                          <div className="text-[10px] text-muted-foreground font-bold uppercase mb-1">Total Strokes</div>
                          <div className="text-2xl font-black italic">
                            {(() => {
                              const total = (currentPlayer?.strokeScores || []).reduce((a, b) => a + (b || 0), 0);
                              return total || "-";
                            })()}
                          </div>
                        </div>
                        <div className="bg-muted/50 p-4 rounded-2xl border border-border">
                          <div className="text-[10px] text-muted-foreground font-bold uppercase mb-1">Avg / Hole</div>
                          <div className="text-2xl font-black italic">
                            {(() => {
                              const scores = (currentPlayer?.strokeScores || []).filter(s => s !== null && s > 0);
                              if (scores.length === 0) return "-";
                              const total = scores.reduce((a, b) => a + (b || 0), 0);
                              return (total / scores.length).toFixed(1);
                            })()}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label className="text-[10px] text-muted-foreground font-bold uppercase px-1">Hole Breakdown</Label>
                        <div className="grid grid-cols-6 gap-2">
                          {(currentPlayer?.strokeScores || Array(18).fill(null)).map((s, idx) => (
                            <div key={idx} className="flex flex-col items-center">
                              <span className="text-[8px] text-muted-foreground font-mono mb-0.5">H{idx + 1}</span>
                              <div className={cn(
                                "w-full h-8 flex items-center justify-center rounded-lg text-xs font-bold border",
                                s !== null ? "bg-blue-accent/10 border-blue-accent/30 text-blue-accent" : "bg-muted/30 border-border text-muted-foreground/30"
                              )}>
                                {s || "-"}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="bg-card border-border rounded-[30px]">
                    <CardHeader>
                      <CardTitle className="text-neon text-sm font-black uppercase tracking-widest">Drive Log ({currentPlayer?.name || 'Me'})</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {metrics.some(m => m.shots.length > 0) ? (
                        metrics.map((h, i) => h.shots.length > 0 && (
                          <div key={i} className="flex justify-between items-center border-b border-border last:border-0 py-2">
                            <span className="text-muted-foreground text-xs font-mono">HOLE {i + 1}</span>
                            <span className="font-bold">{Math.round(h.shots[0].dist)}m</span>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-4 text-muted-foreground text-sm italic">No drives tracked yet</div>
                      )}
                    </CardContent>
                  </Card>

                  <div className="space-y-4">
                    {metrics.map((h, i) => (
                      <Card key={i} className="bg-muted/50 border-border rounded-2xl">
                        <CardContent className="p-4 space-y-2">
                          <div className="flex justify-between items-center">
                            <span className="text-neon font-black text-sm uppercase">Hole {i + 1}</span>
                            <span className="text-[10px] text-muted-foreground font-mono">
                              {Math.floor(h.time / 60)}m {h.time % 60}s
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Total Distance: <span className="text-foreground font-bold">{Math.round(h.meters)}m</span>
                          </div>
                          <div className="space-y-1 pt-2">
                            {h.shots.map((s, si) => (
                              <div key={si} className="text-[10px] flex justify-between border-t border-zinc-800 pt-1">
                                <span className="text-zinc-500">Shot {si + 1}</span>
                                <span className="text-zinc-300 font-mono">{Math.round(s.dist)}m ({s.time}s)</span>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </>
              );
            })()}
          </motion.div>
        )}

        {activeTab === "setup" && (
          <motion.div
            key="setup"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="space-y-6"
          >
            <div className="flex justify-between items-center">
              <h2 className="text-3xl font-black italic">SETUP</h2>
              {user ? (
                <Button variant="ghost" size="sm" onClick={logout} className="text-zinc-500 hover:text-white">
                  <LogOut className="w-4 h-4 mr-2" /> {user.displayName?.split(' ')[0]}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={login} className="border-neon text-neon hover:bg-neon hover:text-black">
                  <LogIn className="w-4 h-4 mr-2" /> LOGIN
                </Button>
              )}
            </div>

            {user && availableGames.length > 0 && (
              <div className="space-y-3">
                <Label className="text-zinc-500 text-[10px] font-bold uppercase px-2">Active Games</Label>
                <div className="grid gap-2">
                  {availableGames.map((g) => (
                    <Card key={g.id} className="bg-zinc-900 border-zinc-800">
                      <CardContent className="p-4 flex justify-between items-center">
                        <div>
                          <div className="font-bold text-white">{g.name}</div>
                          <div className="text-[10px] text-zinc-500">{g.courseName} • {g.players.length} Players</div>
                        </div>
                        <Button size="sm" className="bg-neon text-black font-bold" onClick={() => joinGame(g.id!)}>
                          JOIN
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3">
              <Label className="text-muted-foreground text-[10px] font-bold uppercase px-2">Share App</Label>
              <Card className="bg-muted border-border rounded-2xl">
                <CardContent className="p-4 space-y-4">
                  <div className="text-[10px] text-muted-foreground leading-tight">
                    Open this app on another device to track scores together in real-time.
                  </div>
                  <div className="flex gap-2">
                    <Input 
                      readOnly 
                      value={window.location.origin} 
                      className="bg-background border-border h-10 text-xs"
                    />
                    <Button 
                      size="icon" 
                      variant="secondary" 
                      className="h-10 w-10 shrink-0"
                      onClick={() => {
                        haptic(10);
                        navigator.clipboard.writeText(window.location.origin);
                      }}
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button 
                          size="icon" 
                          variant="secondary" 
                          className="h-10 w-10 shrink-0"
                          onClick={() => haptic(10)}
                        >
                          <QrCode className="w-4 h-4" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="bg-card border-border text-foreground max-w-[300px] flex flex-col items-center p-8">
                        <DialogHeader>
                          <DialogTitle className="text-xl font-black italic uppercase text-center">Scan to Join</DialogTitle>
                        </DialogHeader>
                        <div className="bg-white p-4 rounded-2xl mt-4">
                          <QRCodeSVG 
                            value={window.location.origin} 
                            size={200}
                            level="H"
                            includeMargin={false}
                          />
                        </div>
                        <div className="mt-6 text-center text-[10px] text-muted-foreground font-bold uppercase tracking-widest">
                          Darcy's Pro Golf
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                </CardContent>
              </Card>
            </div>
            
            <Card className="bg-card border-border rounded-[30px]">
              <CardContent className="p-6 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="p-name" className="text-muted-foreground text-[10px] font-bold uppercase">Player Name</Label>
                  <Input 
                    id="p-name" 
                    placeholder="Enter name" 
                    className="bg-muted border-border h-12 rounded-xl"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const name = (e.currentTarget as HTMLInputElement).value;
                        const hcpInput = document.getElementById('p-hcp') as HTMLInputElement;
                        addPlayer(name, parseInt(hcpInput.value));
                        e.currentTarget.value = '';
                        hcpInput.value = '';
                      }
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-hcp" className="text-muted-foreground text-[10px] font-bold uppercase">Handicap</Label>
                  <Input 
                    id="p-hcp" 
                    type="number" 
                    placeholder="Enter handicap" 
                    className="bg-muted border-border h-12 rounded-xl"
                  />
                </div>
                <Button 
                  className="w-full h-12 rounded-xl bg-green-600 hover:bg-green-500 font-bold"
                  onClick={() => {
                    const nameInput = document.getElementById('p-name') as HTMLInputElement;
                    const hcpInput = document.getElementById('p-hcp') as HTMLInputElement;
                    const name = nameInput.value;
                    const hcp = parseInt(hcpInput.value);
                    if (name.trim()) {
                      addPlayer(name, hcp);
                      nameInput.value = '';
                      hcpInput.value = '';
                    }
                  }}
                >
                  <Plus className="w-4 h-4 mr-2" /> ADD PLAYER
                </Button>

                <div className="space-y-2 pt-2">
                  {state.players.map((p, i) => (
                    <div key={i} className="flex justify-between items-center bg-muted p-3 rounded-xl border border-border">
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{p.name}</span>
                        <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">HCP {p.hcp}</Badge>
                      </div>
                      <div className="flex items-center gap-1">
                        <Dialog>
                          <DialogTrigger render={<Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground hover:bg-muted/80" />}>
                            <Settings2 className="w-4 h-4" />
                          </DialogTrigger>
                          <DialogContent className="bg-card border-border text-foreground">
                            <DialogHeader>
                              <DialogTitle>Edit Player</DialogTitle>
                            </DialogHeader>
                            <div className="space-y-4 py-4">
                              <div className="space-y-2">
                                <Label>Name</Label>
                                <Input 
                                  defaultValue={p.name} 
                                  id={`edit-name-${i}`}
                                  className="bg-muted border-border" 
                                />
                              </div>
                              <div className="space-y-2">
                                <Label>Handicap</Label>
                                <Input 
                                  type="number" 
                                  defaultValue={p.hcp} 
                                  id={`edit-hcp-${i}`}
                                  className="bg-muted border-border" 
                                />
                              </div>
                              <div className="flex gap-3">
                                <DialogClose render={<Button variant="outline" className="flex-1 border-border" />}>
                                  CANCEL
                                </DialogClose>
                                <DialogClose render={
                                  <Button 
                                    className="flex-1 bg-neon text-black font-bold"
                                    onClick={() => {
                                      const nameInput = document.getElementById(`edit-name-${i}`) as HTMLInputElement;
                                      const hcpInput = document.getElementById(`edit-hcp-${i}`) as HTMLInputElement;
                                      const name = nameInput.value.trim();
                                      const hcp = parseInt(hcpInput.value);
                                      if (name) {
                                        editPlayer(i, name, isNaN(hcp) ? 0 : hcp);
                                      }
                                    }}
                                  />
                                }>
                                  SAVE CHANGES
                                </DialogClose>
                              </div>
                            </div>
                          </DialogContent>
                        </Dialog>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="text-red-500 hover:text-red-400 hover:bg-red-500/10"
                          onClick={() => removePlayer(i)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="space-y-3">
              <Label className="text-muted-foreground text-[10px] font-bold uppercase px-2">App Theme</Label>
              <div className="flex gap-2 p-1 bg-muted rounded-2xl border border-border">
                <Button 
                  variant="ghost" 
                  className={cn(
                    "flex-1 h-10 rounded-xl font-black italic text-xs transition-all",
                    state.theme === 'light' ? "bg-background text-foreground shadow-lg" : "text-muted-foreground"
                  )}
                  onClick={() => updateState({ theme: 'light' })}
                >
                  <Sun className="w-4 h-4 mr-2" /> LIGHT
                </Button>
                <Button 
                  variant="ghost" 
                  className={cn(
                    "flex-1 h-10 rounded-xl font-black italic text-xs transition-all",
                    state.theme === 'dark' ? "bg-card text-foreground shadow-lg" : "text-muted-foreground"
                  )}
                  onClick={() => updateState({ theme: 'dark' })}
                >
                  <Moon className="w-4 h-4 mr-2" /> DARK
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <Label className="text-muted-foreground text-[10px] font-bold uppercase px-2">Scoring Mode</Label>
              <div className="flex gap-2 p-1 bg-muted rounded-2xl border border-border">
                <Button 
                  variant="ghost" 
                  className={cn(
                    "flex-1 h-10 rounded-xl font-black italic text-xs transition-all",
                    state.scoringType === 'stableford' ? "bg-neon text-black shadow-lg" : "text-muted-foreground"
                  )}
                  onClick={() => updateState({ scoringType: 'stableford' })}
                >
                  STABLEFORD
                </Button>
                <Button 
                  variant="ghost" 
                  className={cn(
                    "flex-1 h-10 rounded-xl font-black italic text-xs transition-all",
                    state.scoringType === 'stroke' ? "bg-blue-accent text-black shadow-lg" : "text-muted-foreground"
                  )}
                  onClick={() => updateState({ scoringType: 'stroke' })}
                >
                  STROKE PLAY
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <Label className="text-muted-foreground text-[10px] font-bold uppercase px-2">Select Course</Label>
              {allCourses.map((c, i) => (
                <div key={i} className="relative group">
                  <Dialog>
                    <DialogTrigger render={<Button className="w-full h-16 rounded-2xl bg-blue-600 hover:bg-blue-500 text-lg font-black italic shadow-lg shadow-blue-900/20" />}>
                      {c.name}
                    </DialogTrigger>
                    <DialogContent className="bg-card border-border text-foreground">
                      <DialogHeader>
                        <DialogTitle>Start Game: {c.name}</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label>Game Name</Label>
                          <Input id="game-name" placeholder="e.g. Sunday Skins" className="bg-muted border-border" />
                        </div>
                        <DialogClose render={
                          <Button className="w-full bg-neon text-black font-bold" onClick={() => {
                            const name = (document.getElementById('game-name') as HTMLInputElement).value || `${c.name} Round`;
                            createGame(i, name);
                          }} />
                        }>
                          START MULTIPLAYER
                        </DialogClose>
                        <div className="relative">
                          <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-border" /></div>
                          <div className="relative flex justify-center text-xs uppercase"><span className="bg-card px-2 text-muted-foreground">Or</span></div>
                        </div>
                        <DialogClose render={
                          <Button variant="outline" className="w-full border-border" onClick={() => selectCourse(i)} />
                        }>
                          START LOCAL ONLY
                        </DialogClose>
                      </div>
                    </DialogContent>
                  </Dialog>
                  {i >= COURSES.length && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute -top-2 -right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        const newCustom = state.customCourses.filter((_, idx) => idx !== (i - COURSES.length));
                        updateState({ customCourses: newCustom });
                      }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              ))}
              
              <CourseCreator 
                onSave={(course) => updateState({ customCourses: [...state.customCourses, course] })} 
                haptic={haptic}
              />
              
              <GolfApiSearch 
                onSelect={(course) => updateState({ customCourses: [...state.customCourses, course] })} 
                haptic={haptic}
              />
            </div>

            {state.curIdx !== -1 && (
              <Button 
                className="w-full h-16 rounded-2xl bg-muted hover:bg-muted/80 text-foreground font-bold border border-border"
                onClick={archiveRound}
              >
                <History className="w-5 h-5 mr-2" /> SAVE ROUND & ARCHIVE
              </Button>
            )}

            <div className="space-y-3 pt-4">
              <Label className="text-muted-foreground text-[10px] font-bold uppercase px-2">History</Label>
              <div className="space-y-2">
                {state.history.length > 0 ? (
                  state.history.slice().reverse().map((h, i) => (
                    <Card key={i} className="bg-muted border-border rounded-2xl">
                      <CardContent className="p-4">
                        <div className="text-neon text-xs font-bold mb-1">{h.name}</div>
                        <div className="text-[10px] text-muted-foreground leading-relaxed">
                          {h.players.join(" | ")}
                        </div>
                      </CardContent>
                    </Card>
                  ))
                ) : (
                  <div className="text-center py-8 text-zinc-700 text-sm italic border-2 border-dashed border-zinc-900 rounded-3xl">
                    No round history yet
                  </div>
                )}
              </div>
            </div>

            <div className="pt-8 flex flex-col gap-4">
              <Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
                <DialogTrigger render={<Button variant="ghost" className="text-red-500/50 hover:text-red-500 text-[10px] font-bold uppercase" />}>
                  Reset Application Data
                </DialogTrigger>
                <DialogContent className="bg-card border-border text-foreground">
                  <DialogHeader>
                    <DialogTitle>Reset All Data?</DialogTitle>
                  </DialogHeader>
                  <div className="py-4 text-sm text-muted-foreground">
                    This will clear all your local history, custom courses, and current game state. This action cannot be undone.
                  </div>
                  <div className="flex gap-3">
                    <Button variant="outline" className="flex-1" onClick={() => setShowResetDialog(false)}>CANCEL</Button>
                    <Button variant="destructive" className="flex-1" onClick={resetApp}>RESET EVERYTHING</Button>
                  </div>
                </DialogContent>
              </Dialog>
              
              <p className="text-[10px] text-zinc-600 text-center uppercase font-bold tracking-widest">
                Darcy's Pro Golf v1.4 • 2024
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Dialog open={selectedPlayerIndex !== null} onOpenChange={(open) => !open && setSelectedPlayerIndex(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-md max-h-[90vh] flex flex-col p-0 overflow-hidden">
          {selectedPlayerIndex !== null && (
            <>
              <DialogHeader className="p-6 pb-2">
                <DialogTitle className="text-2xl font-black italic uppercase">
                  {state.players[selectedPlayerIndex].name}'s Card
                </DialogTitle>
              </DialogHeader>
              <ScrollArea className="flex-1 px-6">
                <div className="py-4 space-y-4">
                  <div className="grid grid-cols-1 gap-2">
                    <div className="flex items-center justify-between text-[10px] font-bold text-muted-foreground uppercase px-2">
                      <span>Hole</span>
                      <div className="flex gap-6">
                        <span className="w-12 text-center">Strokes</span>
                        <span className="w-12 text-center">Points</span>
                      </div>
                    </div>
                    {state.players[selectedPlayerIndex].scores.map((s, idx) => {
                      const stroke = state.players[selectedPlayerIndex].strokeScores?.[idx];
                      const holeData = state.curIdx !== -1 ? allCourses[state.curIdx].holes[idx] : null;
                      return (
                        <div key={idx} className="flex items-center justify-between bg-muted/30 p-3 rounded-xl border border-border/50">
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-black text-neon w-6">#{idx + 1}</span>
                            {holeData && (
                              <span className="text-[10px] text-muted-foreground font-mono">PAR {holeData.p}</span>
                            )}
                          </div>
                          <div className="flex gap-6">
                            <span className="w-12 text-center font-bold text-blue-accent">{stroke || "-"}</span>
                            <span className="w-12 text-center font-bold text-neon">{s !== null ? s : "-"}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </ScrollArea>
              <DialogFooter className="p-6 pt-2">
                <Button className="w-full bg-muted hover:bg-muted/80 font-bold rounded-xl" onClick={() => setSelectedPlayerIndex(null)}>
                  CLOSE SCORECARD
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <nav className="fixed bottom-0 left-0 right-0 bg-black/80 backdrop-blur-xl border-t border-zinc-800 px-4 py-4 z-50">
        <div className="max-w-md mx-auto flex justify-between items-center">
          <NavButton 
            active={activeTab === "play"} 
            onClick={() => setActiveTab("play")} 
            icon={<PlayCircle className="w-6 h-6" />} 
            label="PLAY" 
            haptic={haptic}
          />
          <NavButton 
            active={activeTab === "score"} 
            onClick={() => setActiveTab("score")} 
            icon={<ListOrdered className="w-6 h-6" />} 
            label="SCORE" 
            haptic={haptic}
          />
          <NavButton 
            active={activeTab === "data"} 
            onClick={() => setActiveTab("data")} 
            icon={<BarChart3 className="w-6 h-6" />} 
            label="DATA" 
            haptic={haptic}
          />
          <NavButton 
            active={activeTab === "setup"} 
            onClick={() => setActiveTab("setup")} 
            icon={<Settings2 className="w-6 h-6" />} 
            label="SETUP" 
            haptic={haptic}
          />
        </div>
      </nav>
    </div>
  );
}

function NavButton({ active, onClick, icon, label, haptic }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; haptic: (p?: number) => void }) {
  return (
    <button 
      onClick={() => {
        haptic(10);
        onClick();
      }}
      className={cn(
        "flex flex-col items-center gap-1 transition-all duration-300",
        active ? "text-neon scale-110" : "text-zinc-600 hover:text-zinc-400"
      )}
    >
      {icon}
      <span className="text-[10px] font-black tracking-tighter">{label}</span>
      {active && (
        <motion.div 
          layoutId="nav-indicator" 
          className="w-1 h-1 rounded-full bg-neon mt-0.5"
        />
      )}
    </button>
  );
}

function CourseCreator({ onSave, haptic }: { onSave: (course: Course) => void; haptic: (p?: number | number[]) => void }) {
  const [name, setName] = useState("");
  const [numHoles, setNumHoles] = useState(18);
  const [holes, setHoles] = useState<Hole[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setHoles(Array.from({ length: numHoles }, () => ({ p: 4, idx: 1 })));
  }, [numHoles]);

  const handleSave = () => {
    if (!name) return;
    haptic([20, 20]);
    onSave({ name, holes });
    setName("");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="w-full h-12 rounded-xl border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground" />}>
        <Plus className="w-4 h-4 mr-2" /> CREATE CUSTOM COURSE
      </DialogTrigger>
      <DialogContent className="bg-card border-border text-foreground max-w-md max-h-[90vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-2">
          <DialogTitle className="text-2xl font-black italic">NEW COURSE</DialogTitle>
        </DialogHeader>
        
        <ScrollArea className="flex-1 px-6">
          <div className="space-y-6 py-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground text-[10px] font-bold uppercase">Course Name</Label>
              <Input 
                value={name} 
                onChange={(e) => setName(e.target.value)} 
                placeholder="e.g. My Local Club"
                className="bg-muted border-border h-12 rounded-xl"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground text-[10px] font-bold uppercase">Number of Holes</Label>
              <div className="flex gap-2">
                {[9, 18].map((n) => (
                  <Button
                    key={n}
                    variant={numHoles === n ? "default" : "secondary"}
                    className={cn(
                      "flex-1 h-10 rounded-xl font-bold",
                      numHoles === n ? "bg-neon text-black" : "bg-muted text-muted-foreground"
                    )}
                    onClick={() => setNumHoles(n)}
                  >
                    {n} Holes
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <Label className="text-muted-foreground text-[10px] font-bold uppercase">Hole Details (Par | Index)</Label>
              <div className="grid grid-cols-1 gap-3">
                {holes.map((h, i) => (
                  <div key={i} className="flex items-center gap-3 bg-muted p-3 rounded-xl border border-border">
                    <span className="text-xs font-black text-neon w-6">#{i + 1}</span>
                    <div className="flex-1 grid grid-cols-2 gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground font-bold">PAR</span>
                        <Input 
                          type="number" 
                          value={h.p} 
                          onChange={(e) => {
                            const newHoles = [...holes];
                            newHoles[i].p = parseInt(e.target.value) || 0;
                            setHoles(newHoles);
                          }}
                          className="bg-background border-none h-8 text-center font-bold"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground font-bold">IDX</span>
                        <Input 
                          type="number" 
                          value={h.idx} 
                          onChange={(e) => {
                            const newHoles = [...holes];
                            newHoles[i].idx = parseInt(e.target.value) || 0;
                            setHoles(newHoles);
                          }}
                          className="bg-background border-none h-8 text-center font-bold"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="p-6 pt-2">
          <Button 
            className="w-full h-12 rounded-xl bg-neon text-black font-black hover:bg-neon/90"
            onClick={handleSave}
            disabled={!name}
          >
            SAVE COURSE
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GolfApiSearch({ onSelect, haptic }: { onSelect: (course: Course) => void; haptic: (p?: number | number[]) => void }) {
  const [query, setQuery] = useState("");
  const [clubs, setClubs] = useState<GolfApiClub[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedClub, setSelectedClub] = useState<GolfApiClub | null>(null);
  const [open, setOpen] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    haptic(10);
    setLoading(true);
    const results = await searchClubs(query);
    setClubs(results);
    setLoading(false);
  };

  const handleClubSelect = async (club: GolfApiClub) => {
    haptic(10);
    setLoading(true);
    const details = await getClubDetails(club.id);
    setSelectedClub(details);
    setLoading(false);
  };

  const handleCourseSelect = async (courseId: string) => {
    haptic([20, 20]);
    setLoading(true);
    const course = await getCourseDetails(courseId);
    if (course) {
      onSelect(course);
      setOpen(false);
      setQuery("");
      setClubs([]);
      setSelectedClub(null);
    }
    setLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="w-full h-12 rounded-xl border border-blue-500/30 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10" />}>
        <Globe className="w-4 h-4 mr-2" /> SEARCH GOLFAPI.IO
      </DialogTrigger>
      <DialogContent className="bg-card border-border text-foreground max-w-md max-h-[90vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-2">
          <DialogTitle className="text-2xl font-black italic">GOLFAPI SEARCH</DialogTitle>
        </DialogHeader>
        
        <div className="px-6 py-2 flex gap-2">
          <Input 
            value={query} 
            onChange={(e) => setQuery(e.target.value)} 
            placeholder="Club name, city or country..."
            className="bg-muted border-border h-10 rounded-xl"
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <Button onClick={handleSearch} disabled={loading} className="bg-blue-600 hover:bg-blue-500 h-10 px-3">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </Button>
        </div>

        <ScrollArea className="flex-1 px-6">
          <div className="space-y-3 py-4">
            {!selectedClub ? (
              clubs.length > 0 ? (
                clubs.map((club) => (
                  <Card 
                    key={club.id} 
                    className="bg-muted border-border hover:border-blue-500/50 cursor-pointer transition-colors"
                    onClick={() => handleClubSelect(club)}
                  >
                    <CardContent className="p-4">
                      <div className="font-bold">{club.name}</div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        {club.city}, {club.country}
                      </div>
                    </CardContent>
                  </Card>
                ))
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm italic">
                  Search over 42,000 courses worldwide
                </div>
              )
            ) : (
              <div className="space-y-4">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => setSelectedClub(null)}
                  className="text-blue-400 p-0 h-auto hover:bg-transparent"
                >
                  <ChevronLeft className="w-4 h-4 mr-1" /> BACK TO RESULTS
                </Button>
                <div className="font-black italic text-xl">{selectedClub.name}</div>
                <div className="space-y-2">
                  <Label className="text-[10px] font-bold uppercase text-muted-foreground">Available Courses</Label>
                  {selectedClub.courses?.map((course) => (
                    <Button 
                      key={course.id}
                      variant="outline"
                      className="w-full justify-start h-12 border-border hover:border-neon hover:text-neon"
                      onClick={() => handleCourseSelect(course.id)}
                      disabled={loading}
                    >
                      {course.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
