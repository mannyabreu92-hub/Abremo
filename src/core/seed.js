// Deterministic demo world: 240 artists across 12 countries, ~600 artworks,
// with simulated engagement from fans, artists, critics and collectors.

import { mulberry32, pick, randInt, clamp } from './random.js';
import { emptyRoleCounts } from './scoring.js';
import { START_RATING } from './elo.js';

export const CATEGORIES = Object.freeze([
  { id: 'oil', label: 'Oil Painting', emoji: '🖌️', medium: 'Oil on canvas', basePrice: 900 },
  { id: 'illustration', label: 'Illustration', emoji: '✏️', medium: 'Ink & gouache on paper', basePrice: 250 },
  { id: 'sculpture', label: 'Sculpture', emoji: '🗿', medium: 'Cast bronze', basePrice: 1500 },
  { id: 'photography', label: 'Photography', emoji: '📷', medium: 'Archival pigment print', basePrice: 400 },
  { id: 'digital', label: 'Digital Art', emoji: '💻', medium: 'Digital, 4K edition', basePrice: 200 },
  { id: 'street', label: 'Graffiti & Street Art', emoji: '🧱', medium: 'Spray paint on brick', basePrice: 600 },
  { id: 'ai', label: 'AI Art', emoji: '🤖', medium: 'Diffusion model + hand overpaint', basePrice: 150 },
  { id: 'nft', label: 'NFT', emoji: '🪙', medium: 'On-chain token, edition of 1', basePrice: 300 },
  { id: 'mixed', label: 'Mixed Media', emoji: '🧩', medium: 'Acrylic, paper & found objects', basePrice: 500 },
]);

export const STYLES = Object.freeze([
  'Impressionism', 'Expressionism', 'Abstract', 'Minimalism', 'Pop Art',
  'Realism', 'Surrealism', 'Cubism', 'Futurism', 'Vaporwave',
]);

const STYLES_BY_CATEGORY = {
  oil: ['Impressionism', 'Expressionism', 'Realism', 'Abstract', 'Surrealism', 'Cubism'],
  illustration: ['Pop Art', 'Surrealism', 'Minimalism', 'Realism', 'Vaporwave', 'Impressionism'],
  sculpture: ['Abstract', 'Minimalism', 'Realism', 'Futurism'],
  photography: ['Realism', 'Minimalism', 'Surrealism', 'Abstract'],
  digital: ['Vaporwave', 'Futurism', 'Abstract', 'Surrealism', 'Pop Art'],
  street: ['Pop Art', 'Expressionism', 'Abstract'],
  ai: ['Surrealism', 'Futurism', 'Abstract', 'Vaporwave', 'Impressionism'],
  nft: ['Pop Art', 'Vaporwave', 'Futurism', 'Abstract'],
  mixed: ['Abstract', 'Expressionism', 'Cubism', 'Pop Art', 'Surrealism'],
};

export const COUNTRIES = Object.freeze([
  { code: 'US', name: 'United States', flag: '🇺🇸',
    first: ['Sarah', 'Mark', 'David', 'Emily', 'Jasmine', 'Tyler', 'Olivia', 'Marcus', 'Grace', 'Andre'],
    last: ['Lee', 'Jones', 'Kim', 'Carter', 'Brooks', 'Nguyen', 'Rivera', 'Walker', 'Hayes', 'Bennett'] },
  { code: 'FR', name: 'France', flag: '🇫🇷',
    first: ['Pierre', 'Sophie', 'Camille', 'Louis', 'Chloé', 'Antoine', 'Manon', 'Hugo', 'Léa', 'Julien'],
    last: ['Martin', 'Laurent', 'Dubois', 'Moreau', 'Lefèvre', 'Girard', 'Bonnet', 'Fontaine', 'Rousseau', 'Mercier'] },
  { code: 'JP', name: 'Japan', flag: '🇯🇵',
    first: ['Yuki', 'Haruto', 'Aiko', 'Ren', 'Sakura', 'Kenji', 'Mei', 'Sora', 'Hana', 'Daichi'],
    last: ['Tanaka', 'Sato', 'Suzuki', 'Takahashi', 'Watanabe', 'Ito', 'Yamamoto', 'Nakamura', 'Kobayashi', 'Kato'] },
  { code: 'BR', name: 'Brazil', flag: '🇧🇷',
    first: ['Lucas', 'Ana', 'Gabriel', 'Beatriz', 'Rafael', 'Larissa', 'Mateus', 'Juliana', 'Thiago', 'Camila'],
    last: ['Silva', 'Santos', 'Oliveira', 'Souza', 'Costa', 'Pereira', 'Almeida', 'Ferreira', 'Ribeiro', 'Carvalho'] },
  { code: 'NG', name: 'Nigeria', flag: '🇳🇬',
    first: ['Chidi', 'Amara', 'Tunde', 'Ngozi', 'Emeka', 'Zainab', 'Kunle', 'Ifeoma', 'Seun', 'Adaeze'],
    last: ['Okafor', 'Adeyemi', 'Eze', 'Balogun', 'Nwosu', 'Okonkwo', 'Bello', 'Obi', 'Afolabi', 'Ogunleye'] },
  { code: 'MX', name: 'Mexico', flag: '🇲🇽',
    first: ['Diego', 'Valeria', 'Santiago', 'Ximena', 'Mateo', 'Renata', 'Emiliano', 'Fernanda', 'Leonardo', 'Regina'],
    last: ['Hernández', 'García', 'López', 'Martínez', 'Ramírez', 'Flores', 'Torres', 'Cruz', 'Morales', 'Reyes'] },
  { code: 'KR', name: 'South Korea', flag: '🇰🇷',
    first: ['Min-jun', 'Seo-yeon', 'Ji-ho', 'Ha-eun', 'Do-yun', 'Su-bin', 'Jae-won', 'Yu-na', 'Hyun-woo', 'Ji-woo'],
    last: ['Kim', 'Lee', 'Park', 'Choi', 'Jung', 'Kang', 'Cho', 'Yoon', 'Jang', 'Lim'] },
  { code: 'DE', name: 'Germany', flag: '🇩🇪',
    first: ['Lukas', 'Hannah', 'Felix', 'Lena', 'Jonas', 'Mia', 'Leon', 'Emma', 'Paul', 'Clara'],
    last: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Wagner', 'Becker', 'Hoffmann', 'Koch', 'Richter'] },
  { code: 'IN', name: 'India', flag: '🇮🇳',
    first: ['Aarav', 'Priya', 'Arjun', 'Ananya', 'Rohan', 'Isha', 'Vikram', 'Diya', 'Kabir', 'Meera'],
    last: ['Sharma', 'Patel', 'Gupta', 'Iyer', 'Reddy', 'Nair', 'Singh', 'Mehta', 'Rao', 'Kapoor'] },
  { code: 'IT', name: 'Italy', flag: '🇮🇹',
    first: ['Marco', 'Giulia', 'Luca', 'Chiara', 'Matteo', 'Francesca', 'Alessandro', 'Sofia', 'Davide', 'Elena'],
    last: ['Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo', 'Ricci', 'Marino', 'Greco'] },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧',
    first: ['Oliver', 'Amelia', 'Harry', 'Isla', 'George', 'Ava', 'Jack', 'Poppy', 'Noah', 'Freya'],
    last: ['Smith', 'Taylor', 'Brown', 'Wilson', 'Evans', 'Thomas', 'Roberts', 'Wright', 'Hughes', 'Green'] },
  { code: 'ES', name: 'Spain', flag: '🇪🇸',
    first: ['Pablo', 'Lucía', 'Álvaro', 'Martina', 'Javier', 'Paula', 'Sergio', 'Carmen', 'Adrián', 'Elena'],
    last: ['Fernández', 'Gómez', 'Ruiz', 'Díaz', 'Moreno', 'Muñoz', 'Romero', 'Navarro', 'Ortega', 'Castillo'] },
]);

export const PALETTES = Object.freeze([
  ['#0b1d51', '#2f4b9a', '#f2c14e', '#f78154', '#e8f1f2'],
  ['#1b263b', '#415a77', '#778da9', '#e0e1dd', '#f4a261'],
  ['#2b0f0e', '#8c1c13', '#e63946', '#f1faee', '#ffb703'],
  ['#0f2027', '#203a43', '#2c5364', '#a8dadc', '#f1c40f'],
  ['#3d348b', '#7678ed', '#f7b801', '#f18701', '#f35b04'],
  ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
  ['#10002b', '#5a189a', '#ff006e', '#fb5607', '#ffbe0b'],
  ['#1d3557', '#457b9d', '#a8dadc', '#f1faee', '#e63946'],
  ['#2d3a3a', '#6b9080', '#a4c3b2', '#cce3de', '#eaf4f4'],
  ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4'],
  ['#03045e', '#0077b6', '#00b4d8', '#90e0ef', '#ff70a6'],
  ['#3a0ca3', '#4361ee', '#4cc9f0', '#f72585', '#fefae0'],
  ['#283618', '#606c38', '#dda15e', '#bc6c25', '#fefae0'],
  ['#14213d', '#fca311', '#e5e5e5', '#000000', '#ffffff'],
]);

const ADJ = ['Midnight', 'Starry', 'Red', 'Silent', 'Golden', 'Electric', 'Velvet', 'Broken', 'Neon', 'Quiet',
  'Burning', 'Paper', 'Hidden', 'Wild', 'Lunar', 'Crimson', 'Blue', 'Last', 'Glass', 'Hollow', 'Tender', 'Salt',
  'Iron', 'Floating', 'Distant', 'Sacred', 'Liquid', 'Restless', 'Amber', 'Winter'];
const NOUN = ['Dreams', 'Ocean', 'Revolution', 'Garden', 'Machine', 'Horizon', 'Echo', 'Bloom', 'City', 'Saint',
  'Orchard', 'Signal', 'Tide', 'Mirror', 'Harbor', 'Requiem', 'Figure', 'Storm', 'Portrait', 'Cathedral', 'Market',
  'Lullaby', 'Archive', 'Engine', 'Mother', 'Desert', 'Choir', 'Window', 'Fever', 'Atlas'];

// The opening tracks of the chart, as in the pitch.
const PINNED_ARTISTS = [
  { country: 'US', name: 'Sarah Lee', talent: 0.97, category: 'oil', styles: ['Impressionism', 'Expressionism'],
    featured: { title: 'Starry Dreams', style: 'Impressionism', quality: 0.995 } },
  { country: 'US', name: 'Mark Jones', talent: 0.94, category: 'photography', styles: ['Realism', 'Minimalism'],
    featured: { title: 'Midnight Ocean', style: 'Realism', quality: 0.985 } },
  { country: 'US', name: 'David Kim', talent: 0.9, category: 'digital', styles: ['Vaporwave', 'Futurism'] },
  { country: 'FR', name: 'Pierre Martin', talent: 0.95, category: 'street', styles: ['Pop Art', 'Expressionism'],
    featured: { title: 'Red Revolution', style: 'Pop Art', quality: 0.975 } },
  { country: 'FR', name: 'Sophie Laurent', talent: 0.91, category: 'sculpture', styles: ['Abstract', 'Minimalism'] },
];

export const ARTISTS_PER_COUNTRY = 20;
export const CURRENT_YEAR = 2026;

function vary(rng, base) {
  return Math.max(0, Math.round(base * (0.6 + 0.8 * rng())));
}

function simulateCounts(rng, q) {
  const likes = emptyRoleCounts();
  const saves = emptyRoleCounts();
  likes.fan = vary(rng, 15 + q ** 3 * 900);
  likes.artist = vary(rng, 1 + q ** 3 * 120);
  likes.critic = vary(rng, q ** 4 * 35);
  likes.collector = vary(rng, q ** 5 * 22);
  saves.fan = vary(rng, 1 + q ** 3 * 80);
  saves.artist = vary(rng, q ** 3 * 10);
  saves.critic = vary(rng, q ** 4 * 4);
  saves.collector = vary(rng, q ** 5 * 8);
  const count = vary(rng, q ** 3 * 9);
  const avg = clamp(Math.round(1 + q * 4 + (rng() - 0.5) * 1.5), 1, 5);
  return { likes, saves, reviews: { count, ratingSum: count * avg } };
}

function simulateFollowers(rng, t) {
  return {
    fan: vary(rng, 30 + t ** 2 * 5000),
    artist: vary(rng, t ** 2 * 300),
    critic: vary(rng, t ** 3 * 40),
    collector: vary(rng, t ** 3 * 60),
  };
}

export function buildSeedWorld(seed = 20261103) {
  const rng = mulberry32(seed);
  const artists = [];
  const artworks = [];
  const usedNames = new Set();
  const usedTitles = new Set();
  let workN = 0;

  const makeTitle = () => {
    for (let i = 0; i < 40; i++) {
      const t = `${pick(rng, ADJ)} ${pick(rng, NOUN)}`;
      if (!usedTitles.has(t)) { usedTitles.add(t); return t; }
    }
    return `${pick(rng, ADJ)} ${pick(rng, NOUN)} ${randInt(rng, 2, 9)}`;
  };
  ['Starry Dreams', 'Midnight Ocean', 'Red Revolution'].forEach((t) => usedTitles.add(t));
  PINNED_ARTISTS.forEach((p) => usedNames.add(p.name));

  for (const country of COUNTRIES) {
    const pinned = PINNED_ARTISTS.filter((p) => p.country === country.code);
    for (let i = 0; i < ARTISTS_PER_COUNTRY; i++) {
      const p = pinned[i];
      let name = p?.name;
      while (!name || (!p && usedNames.has(name))) name = `${pick(rng, country.first)} ${pick(rng, country.last)}`;
      usedNames.add(name);

      const category = p?.category ?? pick(rng, CATEGORIES).id;
      const pool = STYLES_BY_CATEGORY[category];
      const s1 = pick(rng, pool);
      let s2 = pick(rng, pool);
      if (s2 === s1) s2 = pool[(pool.indexOf(s1) + 1) % pool.length];
      const styles = p?.styles ?? [s1, s2];
      const talent = p?.talent ?? clamp(rng() ** 1.8, 0.02, 0.92);

      const artist = {
        id: `a${artists.length}`,
        name,
        country: country.code,
        category,
        styles,
        talent,
        debutYear: p ? randInt(rng, 2014, 2019) : randInt(rng, 2010, CURRENT_YEAR),
        followers: simulateFollowers(rng, talent),
        palette: randInt(rng, 0, PALETTES.length - 1),
      };
      artists.push(artist);

      const nWorks = randInt(rng, 2, 3);
      for (let k = 0; k < nWorks; k++) {
        const feat = k === 0 ? p?.featured : null;
        const cat = feat || rng() < 0.8 ? category : pick(rng, CATEGORIES).id;
        const style = feat?.style ?? (cat === category ? pick(rng, styles) : pick(rng, STYLES_BY_CATEGORY[cat]));
        const quality = feat?.quality ?? clamp(talent + (rng() - 0.5) * 0.25, 0.01, 0.95);
        const catInfo = CATEGORIES.find((c) => c.id === cat);
        const price = Math.max(40, Math.round((catInfo.basePrice * (0.25 + quality ** 2 * 12) * (0.7 + rng() * 0.6)) / 10) * 10);
        artworks.push({
          id: `w${workN++}`,
          title: feat?.title ?? makeTitle(),
          artistId: artist.id,
          category: cat,
          style,
          medium: catInfo.medium,
          year: randInt(rng, Math.max(artist.debutYear, 2016), CURRENT_YEAR),
          price,
          quality,
          palette: PALETTES[(artist.palette + (k * 3)) % PALETTES.length],
          counts: feat ? simulateCounts(() => 0.95, quality) : simulateCounts(rng, quality),
          elo: Math.round(START_RATING + (quality - 0.4) * 500 + (rng() - 0.5) * 120),
        });
      }
    }
  }
  return { artists, artworks };
}

export const categoryById = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
export const countryByCode = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));
