/**
 * Example routes and catalogues.
 *
 * SYNTHETIC_CATALOGUE uses invented titles only, so nothing in synthetic mode can be mistaken
 * for a real title's Qloo score.
 *
 * LIVE_SAMPLE_CATALOGUE is a hand-written list of real, widely known titles that a programmer
 * might plausibly be offered. It is a list of names, not Qloo data. It is used only when a live
 * key is configured.
 *
 * Routes are domestic US pairs on purpose: an LLM cannot reliably guess how Minneapolis and
 * Orlando differ in taste for a given catalogue, and US coverage is the most likely to be dense
 * in the hackathon environment.
 */
import type { SlateRequest } from './agent/types.ts';

export const SYNTHETIC_CATALOGUE = `# Synthetic catalogue: every title below is invented. CSV rows (type,title,year) also work.
movie: Paper Comets (2024)
movie: The Lantern Case (2023)
movie: Saltwater Sunday (2022)
movie: Glass Orbit (2024)
movie: Quiet Fury (2021)
movie: Harborlight (2023)
movie: The Orchard Run (2020)
movie: Northbound Kitchen (2024)
movie: Wedding Weather (2022)
movie: Dragon Puppy Rescue (2023)
movie: Edge of the Mission (2024)
movie: The Band in Room 9 (2021)
movie: Island Taste (2023)
movie: Galaxy Laughs (2022)
tv: Corner Booth
tv: Low Tide Detectives
tv: The Long Table
tv: Starlit Ward
tv: Field Notes
tv: Second Shift
tv: Kitchen Island
tv: Team Season
podcast: Tailwind Stories
podcast: The Layover Hour
podcast: Small Plates Radio
podcast: Case File Commute
podcast: Window Seat Science
podcast: Love and Luggage
music: The Cedar Room
music: Mara Vale
music: Night Ferry
music: Copper Lanes
music: Beat Orbit
music: Love Song Club`;

export const LIVE_SAMPLE_CATALOGUE = `# Sample licensable catalogue: a hand-written list of real titles (not Qloo data).
# Chosen to split by region and genre rather than global blockbusters, so the route matters.
movie: Fargo (1996)
movie: Moonlight (2016)
movie: The Florida Project (2017)
movie: Hidden Figures (2016)
movie: Drumline (2002)
movie: Singles (1992)
movie: Talladega Nights (2006)
movie: Encanto (2021)
movie: Paddington 2 (2017)
movie: Spirited Away (2001)
movie: Hunt for the Wilderpeople (2016)
movie: Coco (2017)
movie: Napoleon Dynamite (2004)
movie: Friday Night Lights (2004)
tv: Letterkenny
tv: Insecure
tv: Yellowstone
tv: Schitt's Creek
tv: Bluey
tv: Northern Exposure
tv: The Great British Bake Off
tv: One Day at a Time
podcast: My Favorite Murder
podcast: Huberman Lab
podcast: Call Her Daddy
podcast: Hidden Brain
podcast: Radiolab
podcast: The Moth
music: Zach Bryan
music: Bad Bunny
music: Gloria Estefan
music: The Lumineers
music: Kendrick Lamar
music: Chris Stapleton
music: Fleetwood Mac
music: Celia Cruz`;

export interface ExampleRoute {
  id: string;
  title: string;
  blurb: string;
  request: Omit<SlateRequest, 'catalogue'>;
}

export const EXAMPLE_ROUTES: ExampleRoute[] = [
  {
    id: 'msp-mco',
    title: 'Minneapolis to Orlando',
    blurb: 'Winter leisure route, family-safe screens, "family" theme.',
    request: { origin: 'Minneapolis', destination: 'Orlando', originShare: 0.7, familySafeOnly: true, theme: 'family', autoConfirm: true },
  },
  {
    id: 'atl-sea',
    title: 'Atlanta to Seattle',
    blurb: 'Business-heavy transcon, even passenger mix.',
    request: { origin: 'Atlanta', destination: 'Seattle', originShare: 0.5, autoConfirm: true },
  },
  {
    id: 'mia-den',
    title: 'Miami to Denver',
    blurb: 'Ski-season route, destination-leaning mix, "sports" theme.',
    request: { origin: 'Miami', destination: 'Denver', originShare: 0.4, theme: 'sports', autoConfirm: true },
  },
];
