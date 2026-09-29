
import React, { useEffect, useRef, useState } from 'react';
import { Job } from '../types';
import { useLanguage } from '../contexts/LanguageContext';
import { Loader2 } from 'lucide-react';

// Declare Leaflet types since we are using CDN
declare const L: any;

interface JobMapProps {
  jobs: Job[];
}

// 1. SPECIFIC CITIES (Exact matches override postal codes)
const CITY_COORDS: Record<string, [number, number]> = {
    // Major Cities
    "oslo": [59.9139, 10.7522],
    "bergen": [60.3913, 5.3221],
    "trondheim": [63.4305, 10.3951],
    "stavanger": [58.9690, 5.7331],
    "kristiansand": [58.1599, 8.0182],
    "tromsø": [69.6492, 18.9553],
    "tromso": [69.6492, 18.9553],
    
    // Innlandet / Gjøvik Region (User Specific)
    "gjøvik": [60.7954, 10.6916],
    "gjovik": [60.7954, 10.6916],
    "hunndalen": [60.7719, 10.6622],
    "raufoss": [60.7267, 10.6172],
    "lena": [60.6738, 10.8143],
    "skreia": [60.6534, 10.9358],
    "biri": [60.9572, 10.6214],
    "moelv": [60.9317, 10.6961],
    "brumunddal": [60.8806, 10.9392],
    "hamar": [60.7945, 11.0679],
    "lillehammer": [61.1153, 10.4662],
    "elverum": [60.8819, 11.5645],
    "dokka": [60.8353, 10.0735],
    "fagernes": [60.9858, 9.2335],
    "gran": [60.3667, 10.5667],
    "hadeland": [60.3667, 10.5667],
    "alvdal": [62.1086, 10.6309], 
    "tynset": [62.2750, 10.7770], 
    "røros": [62.5747, 11.3842],
    "vinstra": [61.5960, 9.7490],
    "otta": [61.7716, 9.5393],

    // Innlandet - Additional towns
    "bismo": [61.8844, 8.2664],
    "furnes": [60.8431, 11.021],
    "gausdal": [61.2641, 9.8532],
    "ottestad": [60.7473, 11.1365],
    "ridabu": [60.8014, 11.1303],
    "skarnes": [60.2539, 11.6804],
    "skjåk": [61.935, 7.9145],
    "snertingdal": [60.8806, 10.3889],
    "stange": [60.6244, 11.3831],
    "svingvoll": [61.2956, 10.1867],
    "tessanden": [61.8485, 8.9638],
    "trysil": [61.3561, 12.367],
    "vestre toten": [60.6276, 10.6131],
    "østre toten": [60.6228, 10.9094],
    "østre gausdal": [61.2591, 10.1554],
    "øyer": [61.3274, 10.504],
    "øystre slidre": [61.251, 9.1165],

    // Viken / Surrounding
    "drammen": [59.7441, 10.2045],
    "fredrikstad": [59.2205, 10.9347],
    "sandnes": [58.8524, 5.7352],
    "sarpsborg": [59.2840, 11.1096],
    "skien": [59.2096, 9.6088],
    "ålesund": [62.4722, 6.1495],
    "aalesund": [62.4722, 6.1495],
    "sandefjord": [59.1312, 10.2166],
    "haugesund": [59.4136, 5.2680],
    "tønsberg": [59.2675, 10.4076],
    "tonsberg": [59.2675, 10.4076],
    "moss": [59.4340, 10.6577],
    "porsgrunn": [59.1405, 9.6561],
    "bodø": [67.2804, 14.4049],
    "bodo": [67.2804, 14.4049],
    "arendal": [58.4610, 8.7725],
    "larvik": [59.0533, 10.0352],
    "halden": [59.1243, 11.3875],
    "molde": [62.7372, 7.1607],
    "kongsberg": [59.6685, 9.6502],
    "horten": [59.4172, 10.4848],
    "asker": [59.8331, 10.4391],
    "lillestrøm": [59.9560, 11.0502],
    "lillestrom": [59.9560, 11.0502],
    "jessheim": [60.1415, 11.1751],
    "drøbak": [59.6631, 10.6300],
    "ski": [59.7196, 10.8358],
    "bærum": [59.8947, 10.5369],
    "baerum": [59.8947, 10.5369],
    "lørenskog": [59.9289, 10.9603],
    "lorenskog": [59.9289, 10.9603],
    "nittedal": [60.0481, 10.8614],
    "ås": [59.6633, 10.7897],
    "as": [59.6633, 10.7897],
    "nesodden": [59.8500, 10.6500],
    "oppegård": [59.7900, 10.8000],
    "rælingen": [59.9400, 11.0300],
    "enebakk": [59.7600, 11.1500],
    "frogn": [59.6600, 10.6300],

    // Additional cities
    "hammerfest": [70.6634, 23.6821],
    "alta": [69.9689, 23.2716],
    "narvik": [68.4385, 17.4272],
    "harstad": [68.7988, 16.5413],
    "svolvær": [68.2342, 14.5684],
    "sortland": [68.6933, 15.4133],
    "finnsnes": [69.2333, 17.9833],
    "kirkenes": [69.7271, 30.0459],
    "honningsvåg": [70.9827, 25.9708],
    "vadsø": [70.0744, 29.7500],
    "vardø": [70.3705, 31.1107],
    "mo i rana": [66.3128, 14.1428],
    "sandnessjøen": [66.0211, 12.6278],
    "brønnøysund": [65.4756, 12.2144],
    "namsos": [64.4667, 11.5000],
    "steinkjer": [64.0150, 11.4944],
    "levanger": [63.7461, 11.3000],
    "verdal": [63.7917, 11.4833],
    "stjørdal": [63.4694, 10.9167],
    "orkanger": [63.3000, 9.8500],
    "melhus": [63.2833, 10.2833],
    "heimdal": [63.3500, 10.3500],
    "malvik": [63.4300, 10.6800],
    "kristiansund": [63.1108, 7.7281],
    "florø": [61.5996, 5.0328],
    "førde": [61.4517, 5.8572],
    "sogndal": [61.2297, 7.1033],
    "voss": [60.6283, 6.4161],
    "stord": [59.7792, 5.5000],
    "leirvik": [59.7792, 5.5000],
    "odda": [60.0692, 6.5458],
    "norheimsund": [60.3667, 6.1333],
    "os": [60.1897, 5.4697],
    "askøy": [60.4000, 5.2000],
    "sotra": [60.3500, 5.0500],
    "knarvik": [60.5500, 5.2833],
    "egersund": [58.4514, 6.0000],
    "bryne": [58.7333, 5.6500],
    "nærbø": [58.6667, 5.6333],
    "jørpeland": [59.0167, 6.0500],
    "sauda": [59.6500, 6.3500],
    "kopervik": [59.2833, 5.3000],
    "randaberg": [59.0000, 5.6167],
    "sola": [58.8833, 5.6167],
    "tananger": [58.9333, 5.5667],
    "klepp": [58.7667, 5.6333],
    "ålgård": [58.7667, 5.8500],
    "mandal": [58.0278, 7.4614],
    "farsund": [58.0956, 6.8047],
    "flekkefjord": [58.2972, 6.6628],
    "lyngdal": [58.1417, 7.0628],
    "vennesla": [58.2667, 7.9667],
    "grimstad": [58.3408, 8.5936],
    "risør": [58.7167, 9.2333],
    "tvedestrand": [58.6167, 8.9333],
    "kragerø": [58.8667, 9.4000],
    "notodden": [59.5658, 9.2583],
    "bø": [59.4167, 9.0500],
    "seljord": [59.4833, 8.6333],
    "rjukan": [59.8789, 8.5917],
    "hønefoss": [60.1667, 10.2500],
    "hokksund": [59.7667, 9.9167],
    "vikersund": [59.9833, 10.0000],
    "geilo": [60.5342, 8.2058],
    "gol": [60.7000, 8.9500],
    "ål": [60.6333, 8.5667],
    "hemsedal": [60.8667, 8.5667],
    "nesbyen": [60.5667, 9.0500],
    "flå": [60.4333, 9.5000],
    
    // Regions/Generic
    "nord-norge": [69.6492, 18.9553], 
    "vestland": [60.3913, 5.3221], 
    "rogaland": [58.9690, 5.7331], 
    "trøndelag": [63.4305, 10.3951], 
    "innlandet": [60.7954, 10.6916],
    "viken": [59.9139, 10.7522],
    "agder": [58.1599, 8.0182],
    "norway": [60.4720, 8.4689], 
    "norge": [60.4720, 8.4689],
};

// 2. REGIONAL POSTAL CODES (Fallback)
const POSTAL_REGIONS: Record<string, [number, number]> = {
    // 00-12 Oslo Area
    "00": [59.9139, 10.7522], "01": [59.9139, 10.7522], "02": [59.9139, 10.7522], "03": [59.94, 10.70], 
    "04": [59.94, 10.77], "05": [59.93, 10.79], "06": [59.91, 10.82], "07": [59.95, 10.66], 
    "08": [59.96, 10.75], "09": [59.95, 10.88], "10": [59.92, 10.87], "11": [59.87, 10.80], 
    "12": [59.84, 10.81],
    // 13-14 Akershus
    "13": [59.92, 10.53], "14": [59.72, 10.83],
    // 15-18 Østfold
    "15": [59.43, 10.66], "16": [59.21, 10.93], "17": [59.28, 11.11], "18": [59.56, 11.33],
    // 19-21 Akershus North
    "19": [60.03, 11.27], "20": [60.00, 11.04], "21": [60.16, 11.45],
    // 22-25 Innlandet East
    "22": [60.19, 12.00], "23": [60.79, 11.07], "24": [60.88, 11.56], "25": [62.27, 10.77],
    // 26-29 Innlandet West
    "26": [61.11, 10.46], "27": [60.36, 10.56], "28": [60.79, 10.69], "29": [60.98, 9.23],
    // 30-36 Buskerud
    "30": [59.74, 10.20], "31": [59.27, 10.41], "32": [59.13, 10.22], "33": [59.97, 9.94],
    "34": [59.75, 10.42], "35": [60.16, 10.25], "36": [59.66, 9.65],
    // 37-39 Telemark
    "37": [59.20, 9.61], "38": [59.40, 9.06], "39": [59.13, 9.66],
    // 40-49 Rogaland/Agder
    "40": [58.97, 5.73], "41": [59.00, 5.80], "42": [59.28, 5.29], "43": [58.85, 5.73], "44": [58.46, 6.00],
    "45": [58.09, 7.50], "46": [58.15, 8.00], "47": [58.33, 7.82], "48": [58.46, 8.77], "49": [58.68, 8.97],
    // 50-59 Vestland
    "50": [60.39, 5.32], "51": [60.35, 5.35], "52": [60.40, 5.30], "53": [60.48, 4.90], "54": [60.10, 5.70],
    "55": [59.41, 5.27], "56": [60.25, 6.00], "57": [60.62, 6.42], "58": [60.39, 5.32], "59": [59.77, 5.49],
    // 60-69 Møre og Romsdal
    "60": [62.47, 6.15], "61": [61.93, 6.07], "62": [62.56, 6.96], "63": [62.55, 7.68], "64": [62.73, 7.16],
    "65": [63.11, 7.73], "66": [62.90, 8.50], "67": [61.94, 5.11], "68": [61.76, 6.22], "69": [61.17, 5.43],
    // 70-79 Trøndelag
    "70": [63.43, 10.39], "71": [63.50, 10.00], "72": [63.00, 10.30], "73": [62.57, 9.60], "74": [63.43, 10.39],
    "75": [63.46, 10.92], "76": [63.74, 11.29], "77": [64.01, 11.49], "78": [64.46, 11.49], "79": [64.84, 11.23],
    // 80-89 Nordland
    "80": [67.28, 14.40], "81": [66.86, 13.68], "82": [67.38, 15.37], "83": [68.12, 13.91], "84": [68.56, 14.91],
    "85": [68.43, 17.42], "86": [66.31, 14.14], "87": [65.83, 13.19], "88": [65.97, 12.30], "89": [65.47, 12.20],
    // 90-99 Troms/Finnmark
    "90": [69.64, 18.95], "91": [69.70, 19.00], "92": [69.23, 18.00], "93": [69.14, 18.61], "94": [68.79, 16.54],
    "95": [69.96, 23.27], "96": [70.66, 23.68], "97": [70.98, 25.97], "98": [70.07, 27.99], "99": [69.72, 30.05]
};

const getColorByStatus = (status: string, applicationStatus?: string) => {
    // Priority 1: Check application status (more specific)
    if (applicationStatus) {
        if (applicationStatus === 'sent') return '#22c55e'; // green - sent
        if (applicationStatus === 'sending') return '#eab308'; // yellow - sending
        if (applicationStatus === 'failed') return '#ef4444'; // red - failed
        if (applicationStatus === 'approved') return '#3b82f6'; // blue - approved
        if (applicationStatus === 'draft') return '#f97316'; // orange - draft
    }

    // Priority 2: Job status
    const s = (status || '').toUpperCase();
    if (s.includes('NEW')) return '#3b82f6';
    if (s.includes('ANALYZED')) return '#a855f7';
    if (s.includes('APPROVED') || s.includes('DRAFT') || s.includes('MANUAL')) return '#f97316';
    if (s.includes('SENT') || s.includes('APPLIED')) return '#22c55e';
    if (s.includes('REJECTED') || s.includes('FAILED')) return '#ef4444';
    return '#64748b';
};

// Global cache to persist across re-renders
const COORD_CACHE: Record<string, [number, number]> = {};

export const JobMap: React.FC<JobMapProps> = ({ jobs }) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const [geoJobs, setGeoJobs] = useState<any[]>([]);
  const [asyncResolved, setAsyncResolved] = useState<Record<string, [number, number]>>({});
  const [isGeocoding, setIsGeocoding] = useState(false);
  const { t } = useLanguage();

  // --- COORDINATE RESOLVER ---
  // Helper: Try to find a known city in a complex location string
  // Returns coords if found, null if needs Nominatim
  const tryLocalGeocode = (location: string): [number, number] | null => {
      const cleanLoc = location.toLowerCase().trim();

      // Direct cache hit
      if (CITY_COORDS[cleanLoc]) return CITY_COORDS[cleanLoc];

      // Parse: "Teknologiveien 12, 2815 Gjøvik" → ["teknologiveien 12", "gjøvik"]
      const parts = cleanLoc
          .replace(/\d{4}/g, ' ')           // Remove postal codes
          .split(/[,\/\-–]|\s+og\s+/)       // Split by , / - – or " og "
          .map(p => p.trim())
          .filter(p => p.length > 1);

      // Try each part as a city
      for (const part of parts) {
          if (CITY_COORDS[part]) return CITY_COORDS[part];
      }

      // Try substring match (e.g., "Gjøvik kommune" contains "gjøvik")
      for (const key of Object.keys(CITY_COORDS)) {
          if (cleanLoc.includes(key)) return CITY_COORDS[key];
      }

      return null; // Not found locally
  };

  const getCoords = (location: string): [number, number] => {
      if (!location) return CITY_COORDS['norway'];

      // 1. High Priority: Async/Accurate Cache (Nominatim Result)
      if (asyncResolved[location]) return asyncResolved[location];
      if (COORD_CACHE[location]) return COORD_CACHE[location];

      // 2. Medium Priority: Local City Lookup
      const localResult = tryLocalGeocode(location);
      if (localResult) return localResult;

      // 3. Low Priority: Postal Code Region Fallback
      const postalMatch = location.match(/\b\d{4}\b/);
      if (postalMatch) {
          const zip = postalMatch[0];
          const regionPrefix = zip.substring(0, 2);
          if (POSTAL_REGIONS[regionPrefix]) {
              const suffix = parseInt(zip.substring(2, 4));
              const [lat, lng] = POSTAL_REGIONS[regionPrefix];
              return [lat + (suffix * 0.003), lng + (suffix * 0.003)];
          }
      }

      return CITY_COORDS['norway'];
  };

  // --- ASYNC GEOCODING LOGIC (Nominatim) ---
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;

    const fetchCoords = async () => {
        // Filter jobs needing geocoding:
        // - Has location with digits (street address, postal code)
        // - Not already in cache
        // - Cannot be resolved locally (no known city in the string)
        const targets = jobs.filter(j =>
            j.location &&
            /\d/.test(j.location) &&
            !COORD_CACHE[j.location] &&
            !tryLocalGeocode(j.location)  // Skip if local parsing finds a city!
        );

        // Explicitly typed as string array to prevent inference errors
        const uniqueLocations: string[] = Array.from(new Set(targets.map(j => j.location)));
        if (uniqueLocations.length === 0) return;

        setIsGeocoding(true);

        for (const loc of uniqueLocations) {
            if (signal.aborted) break;

            const cacheKey = `geo_cache_${loc.replace(/\s+/g, '_').toLowerCase()}`;
            
            // 1. Check LocalStorage
            const stored = localStorage.getItem(cacheKey);
            if (stored) {
                try {
                    const parsed = JSON.parse(stored);
                    COORD_CACHE[loc] = parsed;
                    setAsyncResolved(prev => ({ ...prev, [loc]: parsed }));
                    continue; 
                } catch(e) {}
            }

            // 2. Fetch from Nominatim
            try {
                // Rate limit: 1.2s delay to respect OpenStreetMap policy
                await new Promise(r => setTimeout(r, 1200));
                if (signal.aborted) break;

                const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(loc)}&countrycodes=no&limit=1`, { signal });
                
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.length > 0) {
                        const lat = parseFloat(data[0].lat);
                        const lon = parseFloat(data[0].lon);
                        const coords: [number, number] = [lat, lon];
                        
                        localStorage.setItem(cacheKey, JSON.stringify(coords));
                        COORD_CACHE[loc] = coords;
                        setAsyncResolved(prev => ({ ...prev, [loc]: coords }));
                    } else {
                        // FALLBACK: Try to parse postal code region immediately
                        const postalMatch = loc.match(/\b(\d{4})\b/);
                        if (postalMatch) {
                            const zip = postalMatch[1];
                            const regionPrefix = zip.substring(0, 2);
                            if (POSTAL_REGIONS[regionPrefix]) {
                                const [baseLat, baseLng] = POSTAL_REGIONS[regionPrefix];
                                const suffix = parseInt(zip.substring(2, 4)) || 0;
                                const fallbackCoords: [number, number] = [baseLat + (suffix * 0.001), baseLng + (suffix * 0.001)];
                                
                                // Cache fallback to stop retrying
                                localStorage.setItem(cacheKey, JSON.stringify(fallbackCoords));
                                COORD_CACHE[loc] = fallbackCoords;
                                setAsyncResolved(prev => ({ ...prev, [loc]: fallbackCoords }));
                            }
                        } else {
                            // If no postal code, mark as failed in cache to avoid retry loop
                            // Use Norway default but maybe flag it? For now just cache Norway coords.
                            localStorage.setItem(cacheKey, JSON.stringify(CITY_COORDS['norway']));
                            COORD_CACHE[loc] = CITY_COORDS['norway'];
                        }
                    }
                }
            } catch (e: any) {
                if (e.name !== 'AbortError') console.warn("Geocoding failed for", loc, e);
            }
        }
        setIsGeocoding(false);
    };

    fetchCoords();
    return () => controller.abort();
  }, [jobs]); // Re-run if jobs list changes

  // --- MAP RENDER & JITTER ---
  useEffect(() => {
    // Group jobs by resolved coordinates
    const grouped: Record<string, typeof jobs> = {};
    
    jobs.forEach(job => {
        const coords = getCoords(job.location);
        const key = `${coords[0].toFixed(5)},${coords[1].toFixed(5)}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(job);
    });

    const processed = [];
    
    Object.entries(grouped).forEach(([key, group]) => {
        const [baseLat, baseLng] = key.split(',').map(parseFloat);
        
        if (group.length === 1) {
            processed.push({ ...group[0], lat: baseLat, lng: baseLng });
        } else {
            // Circular Jitter Distribution
            const radius = 0.002; // Visible spread
            const angleStep = (2 * Math.PI) / group.length;
            
            group.forEach((job, i) => {
                const angle = i * angleStep;
                processed.push({
                    ...job,
                    lat: baseLat + Math.cos(angle) * radius * 0.6, // Flatten slightly
                    lng: baseLng + Math.sin(angle) * radius
                });
            });
        }
    });

    setGeoJobs(processed);
  }, [jobs, asyncResolved]); // Re-calculate when coords arrive

  // --- LEAFLET INIT ---
  useEffect(() => {
    // CRITICAL FIX: Check if L is defined before using it
    if (typeof L === 'undefined') {
        console.error("Leaflet library (L) is not loaded. Map cannot render.");
        return;
    }

    if (!mapRef.current || mapInstance.current) return;
    const center: [number, number] = [61.0, 10.0]; 
    // Zoom buttons sit bottom-right: the top-left corner holds the map title badge.
    mapInstance.current = L.map(mapRef.current, { zoomControl: false }).setView(center, 6);
    L.control.zoom({ position: 'bottomright' }).addTo(mapInstance.current);
    // CARTO basemaps started returning an "API KEY REQUIRED" tile (2026-09), so use OSM's own tiles.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(mapInstance.current);
  }, []);

  // --- MARKERS UPDATE ---
  useEffect(() => {
    if (!mapInstance.current || typeof L === 'undefined') return;

    mapInstance.current.eachLayer((layer: any) => {
        if (layer instanceof L.CircleMarker) {
            mapInstance.current.removeLayer(layer);
        }
    });

    if (geoJobs.length === 0) return;

    const bounds = L.latLngBounds([]);

    geoJobs.forEach(job => {
        const color = getColorByStatus(job.status, job.application_status);
        const isSent = job.application_status === 'sent';

        const marker = L.circleMarker([job.lat, job.lng], {
            radius: isSent ? 8 : 6, // Larger marker for sent applications
            fillColor: color,
            color: isSent ? '#166534' : '#ffffff', // Green border for sent
            weight: isSent ? 3 : 2,
            opacity: 1,
            fillOpacity: 0.9
        }).addTo(mapInstance.current);

        const applicationBadge = job.application_status === 'sent'
            ? '<div class="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-green-500 text-white mt-1">✅ ВІДПРАВЛЕНО</div>'
            : job.application_status === 'sending'
            ? '<div class="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-yellow-400 text-yellow-900 mt-1">⏳ НАДСИЛАЄТЬСЯ</div>'
            : job.application_status === 'failed'
            ? '<div class="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-red-500 text-white mt-1">❌ ПОМИЛКА</div>'
            : '';

        const tooltipContent = `
            <div class="p-2 font-sans min-w-[150px]">
                <div class="font-bold text-sm text-slate-900 truncate">${job.title}</div>
                <div class="text-xs text-slate-600 truncate">${job.company}</div>
                <div class="text-xs text-slate-500 mb-2 border-b border-slate-100 pb-1">${job.location}</div>
                <div class="flex items-center justify-between">
                    <div class="inline-block px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase" style="background-color:${color}">
                        ${job.status}
                    </div>
                    ${job.matchScore ? `<div class="text-xs font-bold ${job.matchScore > 70 ? 'text-green-600' : 'text-yellow-600'}">${job.matchScore}%</div>` : ''}
                </div>
                ${applicationBadge}
                ${job.url ? `<a href="${job.url}" target="_blank" rel="noopener noreferrer" class="mt-2 block text-xs text-blue-600 hover:text-blue-800 font-medium">🔗 Переглянути вакансію →</a>` : ''}
            </div>
        `;
        marker.bindPopup(tooltipContent);
        bounds.extend([job.lat, job.lng]);
    });

    if (geoJobs.length > 0) {
        if (geoJobs.length === 1) {
             mapInstance.current.setView([geoJobs[0].lat, geoJobs[0].lng], 10);
        } else {
             mapInstance.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 12 });
        }
    }
  }, [geoJobs]);

  return (
    <div className="relative w-full h-full rounded-lg overflow-hidden">
        <div ref={mapRef} className="w-full h-full bg-slate-100 z-0" />
        
        {/* Loading Indicator */}
        {isGeocoding && (
            <div className="absolute top-12 left-2 z-[1000] bg-white/90 backdrop-blur px-3 py-1.5 rounded-full shadow-md border border-blue-100 flex items-center gap-2 text-xs font-bold text-blue-600 animate-fade-in">
                <Loader2 size={12} className="animate-spin" /> Looking up addresses...
            </div>
        )}

        {/* Legend */}
        <div className="absolute bottom-6 left-2 md:bottom-4 md:left-4 bg-white/95 p-2 md:p-3 rounded-lg shadow-lg backdrop-blur-sm z-[1000] text-[11px] md:text-xs space-y-1 md:space-y-2 border border-slate-200 min-w-[110px]">
            <div className="font-bold text-slate-700 border-b border-slate-100 pb-1 mb-1">Status</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-[#3b82f6] border-2 border-white shadow-sm"></span> {t('jobs.status.new')}</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-[#a855f7] border-2 border-white shadow-sm"></span> {t('jobs.status.analyzed')}</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-[#f97316] border-2 border-white shadow-sm"></span> {t('jobs.status.draft')}</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-[#22c55e] border-2 border-white shadow-sm"></span> {t('jobs.status.sent')}</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-[#ef4444] border-2 border-white shadow-sm"></span> {t('jobs.status.rejected')}</div>
        </div>
    </div>
  );
};
