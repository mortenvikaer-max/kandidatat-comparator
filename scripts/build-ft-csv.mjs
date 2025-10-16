// Konverterer rå JSON fra data/raw/ft/{2015,2019}/... til CSV'er i data/ft/{år}/...,
// i præcis det format din HTML-side forventer.
//
// Antagelser (robuste, men kan tweakes pr. datasæt):
// - Valggeografi indeholder filer der nævner "Storkreds", "Opstillingskreds", "Afstemningsomraade"
// - Valgresultater indeholder filer pr. afstemningsområde med stemmer pr. kandidat/partiliste
// - Kandidatdata supplerer kandidatnavne/partibogstaver (valgfrit, fallback via resultater)
// - Partistemmefordeling er valgfri (bruges ikke direkte her)
//
// Output pr. KREDS: data/ft/<år>/<Storkreds>/<Kreds>_allepartier.csv
// Output pr. STORKREDS: data/ft/<år>/<Storkreds>_allepartier.csv
//
// Kolonner: storkreds,kreds,valgsted_id,valgsted_navn,kandidat_navn,parti,parti_bogstav,stemmer

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

const YEARS = [2015, 2019];

const u = s => (s ?? "").toString().trim();
const us = s => u(s).replace(/\s+/g, "_");
async function ensureDir(p){ await mkdir(p,{recursive:true}); }
function csvLine(arr){ return arr.map(v=> {
  const s = v==null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
}).join(","); }
async function writeCSV(path, header, rows){
  await ensureDir(dirname(path));
  const lines = [csvLine(header), ...rows.map(r=>csvLine(header.map(h=>r[h])))];
  await writeFile(path, lines.join("\n"), "utf8");
}
async function loadJSON(file){
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw);
}
async function listFilesRecursive(dir){
  const out = [];
  async function walk(d){
    const items = await readdir(d, { withFileTypes: true });
    for(const it of items){
      const p = join(d, it.name);
      if(it.isDirectory()) await walk(p);
      else out.push(p);
    }
  }
  try { await walk(dir); } catch {}
  return out;
}
function pickOne(files, ...needles){
  return files.find(f => needles.every(n=> f.toLowerCase().includes(n.toLowerCase())));
}

async function buildYear(year){
  const base = `data/raw/ft/${year}`;
  const files = await listFilesRecursive(base);

  // Find geografi-filer (heuristik på filnavne)
  const storkFile = pickOne(files, "valggeografi", "storkreds", ".json");
  const opsFile   = pickOne(files, "valggeografi", "opstillings", ".json");
  const aomFile   = pickOne(files, "valggeografi", "afstemningsomra", ".json");
  if(!storkFile || !opsFile || !aomFile){
    console.log(`[${year}] Kunne ikke finde alle geografi-filer. Fundet:`, {storkFile, opsFile, aomFile});
    throw new Error("Manglende geografi-filer");
  }

  const stork = await loadJSON(storkFile);
  const ops   = await loadJSON(opsFile);
  const aoms  = await loadJSON(aomFile);

  // Indexér geografi
  const storkById = new Map(); // id -> navn
  for(const s of (Array.isArray(stork) ? stork : (stork.data || []))){
    const id = s.Kode ?? s.Id ?? s.Nummer ?? s.StorkredsId;
    if(id!=null) storkById.set(id, u(s.Navn));
  }

  const opsById = new Map(); // id -> {navn, storkId}
  for(const o of (Array.isArray(ops) ? ops : (ops.data || []))){
    const id = o.Kode ?? o.Id ?? o.Nummer ?? o.OpstillingskredsId;
    const storkId = o.StorkredsReference?.Kode ?? o.StorkredsId ?? o.StorkredsKode;
    if(id!=null) opsById.set(id, { navn: u(o.Navn), storkId });
  }

  const aomIndex = new Map(); // key "Kommune||AOM" -> {navn, opsId}
  for(const a of (Array.isArray(aoms) ? aoms : (aoms.data || []))){
    const key = `${u(a.Kommune?.Navn ?? a.Kommunenavn)}||${u(a.Navn)}`;
    const opsId = a.OpstillingskredsReference?.Kode ?? a.OpstillingskredsId ?? a.OpstillingskredsKode;
    aomIndex.set(key, { navn: u(a.Navn), opsId });
  }

  // Indlæs kandidatdata (optional, til at supplere navne/partier/bogstav)
  const candFiles = files.filter(f => f.toLowerCase().includes("/kandidatdata/") && f.endsWith(".json"));
  const kandidatIndex = new Map(); // kandidatId -> {navn, parti, parti_bogstav}
  const partiLetterByName = new Map(); // partinavn(lower) -> bogstav
  for(const f of candFiles){
    const j = await loadJSON(f);
    const partier = j?.Valg?.IndenforParti ?? j?.IndenforParti ?? [];
    for(const p of partier){
      const pnavn = u(p.Navn ?? p.PartiNavn ?? p.Parti?.Navn);
      const bog   = u(p.Bogstav ?? p.Parti?.Bogstav);
      if(pnavn) partiLetterByName.set(pnavn.toLowerCase(), bog);
      const kandidater = p.Kandidater ?? [];
      for(const k of kandidater){
        const kid = u(k.Id ?? k.KandidatId ?? "");
        if(!kid) continue;
        kandidatIndex.set(kid, { navn: u(k.Navn), parti: pnavn, parti_bogstav: bog });
      }
    }
    const udenfor = j?.Valg?.UdenforParti?.Kandidater ?? [];
    for(const k of udenfor){
      const kid = u(k.Id ?? k.KandidatId ?? "");
      if(!kid) continue;
      kandidatIndex.set(kid, { navn: u(k.Navn), parti: "Uden for parti", parti_bogstav: "-" });
    }
  }

  // Indlæs valgresultater
  const resFiles = files.filter(f => f.toLowerCase().includes("/valgresultater/") && f.endsWith(".json"));
  const rowsByKreds = new Map(); // "Storkreds||Kreds" -> rows[]

  for(const f of resFiles){
    const j = await loadJSON(f);
    const vr = j?.Valgresultater ?? j; // nogle eksporter har rodfelter
    const kommune = u(vr?.Kommune?.Navn ?? vr?.Kommunenavn);
    const aomNavn = u(vr?.Afstemningsomraade?.Navn ?? vr?.Afstemningsomraadenavn);
    if(!kommune || !aomNavn) continue;

    const aom = aomIndex.get(`${kommune}||${aomNavn}`) ?? {};
    const ops = opsById.get(aom.opsId) ?? {};
    const storkNavn = u(storkById.get(ops.storkId)) || "";
    const opsNavn   = u(ops.navn) || "";

    // Indenfor parti
    const partier = vr?.IndenforParti ?? [];
    for(const p of partier){
      const pnavn = u(p.Navn ?? p.PartiNavn);
      const letter = u(p.Bogstav) || partiLetterByName.get(pnavn.toLowerCase()) || "";

      // Partiliste (hvis feltet findes)
      if(p.Partistemmer != null){
        const row = {
          storkreds: storkNavn,
          kreds: opsNavn,
          valgsted_id: aomNavn,     // fallback: brug navn som ID
          valgsted_navn: aomNavn,
          kandidat_navn: "Partiliste",
          parti: pnavn,
          parti_bogstav: letter,
          stemmer: Number(p.Partistemmer) || 0
        };
        const key = `${storkNavn}||${opsNavn}`;
        (rowsByKreds.get(key) ?? rowsByKreds.set(key, []).get(key)).push(row);
      }

      // Kandidater
      const kandidater = p.Kandidater ?? [];
      for(const k of kandidater){
        const kid = u(k.Id ?? k.KandidatId ?? "");
        const info = kandidatIndex.get(kid) || { navn: u(k.Navn), parti: pnavn, parti_bogstav: letter };
        const row = {
          storkreds: storkNavn,
          kreds: opsNavn,
          valgsted_id: aomNavn,
          valgsted_navn: aomNavn,
          kandidat_navn: info.navn || u(k.Navn),
          parti: info.parti || pnavn,
          parti_bogstav: info.parti_bogstav || letter,
          stemmer: Number(k.Stemmer) || 0
        };
        const key = `${storkNavn}||${opsNavn}`;
        (rowsByKreds.get(key) ?? rowsByKreds.set(key, []).get(key)).push(row);
      }
    }

    // Udenfor parti
    const udenfor = vr?.KandidaterUdenforParti ?? vr?.UdenforParti ?? [];
    const udenforKandidater = Array.isArray(udenfor) ? udenfor : (udenfor.Kandidater ?? []);
    for(const k of udenforKandidater){
      const kid = u(k.Id ?? k.KandidatId ?? "");
      const info = kandidatIndex.get(kid) || { navn: u(k.Navn), parti: "Uden for parti", parti_bogstav: "-" };
      const row = {
        storkreds: storkNavn,
        kreds: opsNavn,
        valgsted_id: aomNavn,
        valgsted_navn: aomNavn,
        kandidat_navn: info.navn || u(k.Navn),
        parti: info.parti || "Uden for parti",
        parti_bogstav: info.parti_bogstav || "-",
        stemmer: Number(k.Stemmer) || 0
      };
      const key = `${storkNavn}||${opsNavn}`;
      (rowsByKreds.get(key) ?? rowsByKreds.set(key, []).get(key)).push(row);
    }
  }

  // Skriv CSV pr. kreds og samlet pr. storkreds
  const header = ["storkreds","kreds","valgsted_id","valgsted_navn","kandidat_navn","parti","parti_bogstav","stemmer"];

  // Stash for storkreds-aggregering
  const byStork = new Map();

  for(const [key, rows] of rowsByKreds.entries()){
    const [storkNavn, opsNavn] = key.split("||");
    const dirKreds = `data/ft/${year}/${us(storkNavn)}`;
    await writeCSV(`${dirKreds}/${us(opsNavn)}_allepartier.csv`, header, rows);

    const list = byStork.get(storkNavn) ?? [];
    list.push(...rows);
    byStork.set(storkNavn, list);
  }

  for(const [storkNavn, rows] of byStork.entries()){
    await writeCSV(`data/ft/${year}/${us(storkNavn)}_allepartier.csv`, header, rows);
  }

  console.log(`✔️ Bygget CSV for ${year}: ${byStork.size} storkredse`);
}

for (const year of YEARS){
  await buildYear(year);
}
console.log("✅ Konvertering færdig.");
