import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIRECTORY = resolve(ROOT, "assets");
const SNAPSHOT_PATH = resolve(ROOT, "scripts/activity-snapshot.json");
const FONT_PATH = resolve(
  ROOT,
  "node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
);

const USERNAME = process.env.GITHUB_USERNAME || "rosa-gus";
const WINDOW_DAYS = 90;
const LEVELS = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

const THEMES = {
  light: {
    foreground: "#1f2328",
    muted: "#656d76",
    faint: "#d0d7de",
    levels: ["#d0d7de", "#8c959f", "#656d76", "#3d444d", "#1f2328"],
  },
  dark: {
    foreground: "#f0f6fc",
    muted: "#8b949e",
    faint: "#30363d",
    levels: ["#30363d", "#6e7681", "#8b949e", "#b1bac4", "#f0f6fc"],
  },
};

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function shiftDate(date, days) {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeDays(days, from, to) {
  const indexed = new Map(days.map((day) => [day.date, day]));
  const normalized = [];

  for (let date = parseDate(from); date <= parseDate(to); date = shiftDate(date, 1)) {
    const key = formatDate(date);
    const day = indexed.get(key);
    normalized.push({
      date: key,
      count: day?.count ?? 0,
      level: Math.max(0, Math.min(4, day?.level ?? 0)),
    });
  }

  return normalized;
}

function longestStreak(days) {
  let longest = 0;
  let current = 0;

  for (const day of days) {
    current = day.count > 0 ? current + 1 : 0;
    longest = Math.max(longest, current);
  }

  return longest;
}

async function fetchActivity() {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
    return {
      ...snapshot,
      days: normalizeDays(snapshot.days, snapshot.from, snapshot.to),
      source: "public profile snapshot",
    };
  }

  const toDate = new Date();
  const fromDate = shiftDate(toDate, -(WINDOW_DAYS - 1));
  const from = formatDate(fromDate);
  const to = formatDate(toDate);
  const query = `
    query ProfileActivity($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                contributionCount
                contributionLevel
                date
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "rosa-gus-profile-readme",
    },
    body: JSON.stringify({
      query,
      variables: {
        login: USERNAME,
        from: `${from}T00:00:00.000Z`,
        to: `${to}T23:59:59.999Z`,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  const weeks = payload.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!weeks) {
    throw new Error(`GitHub user ${USERNAME} was not found`);
  }

  const days = weeks.flatMap((week) => week.contributionDays).map((day) => ({
    date: day.date,
    count: day.contributionCount,
    level: LEVELS[day.contributionLevel] ?? 0,
  }));

  return {
    username: USERNAME,
    from,
    to,
    days: normalizeDays(days, from, to),
    source: "GitHub GraphQL API",
  };
}

function buildCalendar(days) {
  const firstDate = parseDate(days[0].date);
  const lastDate = parseDate(days.at(-1).date);
  const calendarStart = shiftDate(firstDate, -firstDate.getUTCDay());
  const calendarEnd = shiftDate(lastDate, 6 - lastDate.getUTCDay());
  const indexed = new Map(days.map((day) => [day.date, day]));
  const weeks = [];

  for (let weekStart = calendarStart; weekStart <= calendarEnd; weekStart = shiftDate(weekStart, 7)) {
    weeks.push(
      Array.from({ length: 7 }, (_, weekday) => {
        const date = shiftDate(weekStart, weekday);
        return indexed.get(formatDate(date)) ?? null;
      }),
    );
  }

  const months = [];
  let previousMonth = null;
  for (let week = 0; week < weeks.length; week += 1) {
    const visibleDay = weeks[week].find(Boolean);
    if (!visibleDay) continue;
    const date = parseDate(visibleDay.date);
    const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
    if (month !== previousMonth) {
      months.push({ label: month, week });
      previousMonth = month;
    }
  }

  return { weeks, months };
}

function renderSvg(activity, fontData, themeName) {
  const theme = THEMES[themeName];
  const { weeks, months } = buildCalendar(activity.days);
  const width = 860;
  const height = 220;
  const gridX = 116;
  const gridY = 77;
  const columnWidth = Math.min(48, Math.floor((width - gridX - 30) / weeks.length));
  const rowHeight = 15;
  const glyphs = [".", ":", "+", "#", "@"]; 
  const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const total = activity.days.reduce((sum, day) => sum + day.count, 0);
  const activeDays = activity.days.filter((day) => day.count > 0).length;
  const streak = longestStreak(activity.days);
  const updated = activity.to;

  const monthLabels = months
    .map(
      ({ label, week }) =>
        `<text class="meta" x="${gridX + week * columnWidth}" y="61">${label}</text>`,
    )
    .join("\n    ");

  const weekdayLabels = weekdays
    .map((label, row) => `<text class="meta" x="24" y="${gridY + row * rowHeight}">${label}</text>`)
    .join("\n    ");

  const cells = weeks
    .flatMap((week, column) =>
      week.map((day, row) => {
        if (!day) return "";
        const x = gridX + column * columnWidth;
        const y = gridY + row * rowHeight;
        const noun = day.count === 1 ? "contribution" : "contributions";
        return `<text class="cell level-${day.level}" x="${x}" y="${y}"><title>${escapeXml(day.date)}: ${day.count} ${noun}</title>${glyphs[day.level]}</text>`;
      }),
    )
    .filter(Boolean)
    .join("\n    ");

  const description = `${total} public contributions across ${activeDays} active days from ${activity.from} to ${activity.to}.`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(USERNAME)} engineering activity</title>
  <desc id="description">${escapeXml(description)}</desc>
  <style>
    @font-face {
      font-family: "IBM Plex Mono Embedded";
      font-style: normal;
      font-weight: 400;
      src: url("data:font/woff2;base64,${fontData}") format("woff2");
    }
    text {
      font-family: "IBM Plex Mono Embedded", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-weight: 400;
    }
    .heading { fill: ${theme.foreground}; font-size: 13px; letter-spacing: 0.8px; }
    .meta { fill: ${theme.muted}; font-size: 11px; letter-spacing: 0.6px; }
    .cell { font-size: 14px; text-anchor: middle; }
    .level-0 { fill: ${theme.levels[0]}; }
    .level-1 { fill: ${theme.levels[1]}; }
    .level-2 { fill: ${theme.levels[2]}; }
    .level-3 { fill: ${theme.levels[3]}; }
    .level-4 { fill: ${theme.levels[4]}; }
    .separator { fill: ${theme.faint}; font-size: 10px; }
  </style>
  <text class="separator" x="0" y="42" textLength="860" lengthAdjust="spacingAndGlyphs">${"-".repeat(128)}</text>
  <text class="separator" x="0" y="176" textLength="860" lengthAdjust="spacingAndGlyphs">${"-".repeat(128)}</text>
  <text class="heading" x="0" y="25">ENGINEERING ACTIVITY / LAST 90 DAYS</text>
  <text class="meta" x="848" y="25" text-anchor="end">UPDATED ${updated} / UTC</text>
  <g>
    ${monthLabels}
    ${weekdayLabels}
    ${cells}
  </g>
  <text class="heading" x="0" y="204">CONTRIBUTIONS ${String(total).padStart(3, "0")}</text>
  <text class="heading" x="284" y="204">ACTIVE DAYS ${String(activeDays).padStart(3, "0")}</text>
  <text class="heading" x="534" y="204">LONGEST STREAK ${String(streak).padStart(3, "0")}</text>
  <text class="meta" x="848" y="204" text-anchor="end">SIGNAL .:+#@</text>
</svg>
`;
}

async function main() {
  const [activity, font] = await Promise.all([
    fetchActivity(),
    readFile(FONT_PATH),
  ]);
  const fontData = font.toString("base64");

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await Promise.all(
    Object.keys(THEMES).map((theme) =>
      writeFile(
        resolve(OUTPUT_DIRECTORY, `activity-${theme}.svg`),
        renderSvg(activity, fontData, theme),
        "utf8",
      ),
    ),
  );

  console.log(
    `Generated ${Object.keys(THEMES).length} SVGs for ${activity.username} from ${activity.source}.`,
  );
}

await main();
