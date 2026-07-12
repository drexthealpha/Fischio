// Team -> ISO country code, so we can render real SVG flags that look identical on every
// platform (Windows has no flag-emoji font, so emoji flags degrade to "ES"/"BE" letters
// there; SVG images do not). Keyed by the exact participant names TxLINE uses.
const CODES = {
  Algeria: "dz", Argentina: "ar", Australia: "au", Austria: "at", Belgium: "be",
  "Bosnia & Herzegovina": "ba", Brazil: "br", Canada: "ca", "Cape Verde": "cv",
  Colombia: "co", "Congo DR": "cd", Croatia: "hr", Ecuador: "ec", Egypt: "eg",
  England: "gb-eng", France: "fr", Germany: "de", Ghana: "gh", "Ivory Coast": "ci",
  Japan: "jp", Jordan: "jo", Mexico: "mx", Morocco: "ma", Netherlands: "nl",
  Norway: "no", Paraguay: "py", Portugal: "pt", Senegal: "sn", "South Africa": "za",
  Spain: "es", Sweden: "se", Switzerland: "ch", USA: "us",
};

export const codeOf = (team) => CODES[team] ?? null;
// flagcdn serves crisp SVG flags for free; identical on Windows, Mac, iOS, Android.
export const flagUrl = (team) => { const c = codeOf(team); return c ? `https://flagcdn.com/${c}.svg` : null; };
// a short country-code fallback if the image cannot load
export const codeLabel = (team) => (codeOf(team) ?? team.slice(0, 3)).replace("gb-", "").toUpperCase();
