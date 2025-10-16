// Henter storkredse og opstillingskredse fra Dataforsyningen (DAWA/DAGI)
// og genererer CSV-filer, der kan bruges til dropdowns i din valgside.
// Ingen eksterne pakker – virker på GitHub Actions (Node 18/20 har global fetch).
//
// Output:
//  - data/meta/kredse.csv (kolonner: storkreds,kreds)
//  - data/meta/<Storkreds>_kredse.csv (kolonne: kreds)
// Navne skrives med underscores (fx "Indre_Bykredsen"), så de matcher dine filstier.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const STORKREDS_URL = "https://api.dataforsyningen.dk/storkredse?format=geojson";
const OPKREDS_URL   = "https://api.dataforsyningen.dk/opstillingskredse?format=geojson";
const OUT_DIR = "data/meta";

function slugifyName(name){
  // erstatter mellemrum med underscore og fjerner evt. dobbelte underscores
  return (name||"")
    .replace(/\s+/g, "_")
    .replace(/__/g, "_")
    .trim();
}

async function fetchJSON(url){
  const r = await fetch(url, { headers: { "accept": "application/json" }});
  if(!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.json();
}

async function ensureDir(p){ await mkdir(p, { recursive: true }); }

async function writeCSV(path, rows, header){
  await ensureDir(dirname(path));
  const lines = [header.join(",")].concat(
    rows.map(r=>header.map(h=>{
      const v = r[h] ?? "";
      const s = String(v).replaceAll('"','""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    }).join(","))
  );
  await writeFile(path, lines.join("\n"), "utf8");
}

async function run(){
  const stork = await fetchJSON(STORKREDS_URL);
  const op    = await fetchJSON(OPKREDS_URL);

  const storkFeatures = stork.features || [];
  const opFeatures    = op.features || [];

  // Map storkredsnummer -> navn
  const storkMap = new Map();
  for(const f of storkFeatures){
    const p = f.properties || {};
    storkMap.set(p.nummer, p.navn);
  }

  // Saml opstillingskredse pr. storkredsnummer
  const byStork = new Map();
  for(const f of opFeatures){
    const p = f.properties || {};
    const snr = p.storkredsnummer;
    const name = p.navn;
    if(!byStork.has(snr)) byStork.set(snr, []);
    byStork.get(snr).push(name);
  }

  // Skriv samlet CSV
  const allRows = [];
  for(const [snr, sname] of storkMap.entries()){
    const kredse = (byStork.get(snr) || []).slice().sort((a,b)=>a.localeCompare(b,"da"));
    for(const k of kredse){
      allRows.push({ storkreds: slugifyName(sname), kreds: slugifyName(k) });
    }
  }
  await writeCSV(`${OUT_DIR}/kredse.csv`, allRows, ["storkreds","kreds"]);

  // Skriv per storkreds CSV
  for(const [snr, sname] of storkMap.entries()){
    const kredse = (byStork.get(snr) || []).slice().sort((a,b)=>a.localeCompare(b,"da"));
    const rows = kredse.map(k=>({ kreds: slugifyName(k) }));
    await writeCSV(`${OUT_DIR}/${slugifyName(sname)}_kredse.csv`, rows, ["kreds"]);
  }

  console.log(`Skrev ${allRows.length} rækker til ${OUT_DIR}/kredse.csv og ${storkMap.size} per-storkreds-filer.`);
}

run().catch(err=>{
  console.error(err);
  process.exit(1);
});

