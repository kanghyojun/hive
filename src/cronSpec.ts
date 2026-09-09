// cron 5필드(분 시 일 월 요일)의 서브셋 파서와 스케줄 계산. 외부 의존성 없이 여기서 끝낸다.
// 시각 계산은 전부 로컬 타임존 게터를 쓴다. 테스트가 epoch 상수 대신 Date 생성자를 쓰는 이유다.

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  // 일/요일이 둘 다 지정되면 표준 cron은 둘을 OR로 친다. 그 판정에 "필드가 통짜 *였는가"가 필요하다.
  // */2 처럼 전체를 훑는 스텝은 값 집합은 같아도 star가 아니다.
  domStar: boolean;
  dowStar: boolean;
}

const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseValue(text: string, min: number, max: number, names: string[]): number | null {
  const named = names.indexOf(text.toLowerCase());
  if (named >= 0) return named + min;
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (n < min || n > max) return null;
  return n;
}

interface Field {
  set: Set<number>;
  star: boolean;
}

function parseField(text: string, min: number, max: number, names: string[] = []): Field | null {
  const out = new Set<number>();
  let star = false;
  for (const part of text.split(",")) {
    if (part === "") return null;
    const [rangeText, stepText] = part.split("/");
    if (part.split("/").length > 2) return null;

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return null;
      step = Number(stepText);
      if (step < 1) return null;
    }

    let lo: number;
    let hi: number;
    if (rangeText === "*") {
      lo = min;
      hi = max;
      if (stepText === undefined) star = true;
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-");
      if (rangeText.split("-").length !== 2) return null;
      const loV = parseValue(a, min, max, names);
      const hiV = parseValue(b, min, max, names);
      if (loV === null || hiV === null || loV > hiV) return null;
      lo = loV;
      hi = hiV;
    } else {
      const v = parseValue(rangeText, min, max, names);
      if (v === null) return null;
      lo = v;
      hi = v;
    }

    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  if (out.size === 0) return null;
  return { set: out, star };
}

function sorted(set: Set<number>): Set<number> {
  return new Set([...set].sort((a, b) => a - b));
}

export function parseCron(text: string): CronSpec | null {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") return null;

  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12, MONTH_NAMES);
  // 요일은 0=일요일이고 7도 일요일로 받는다. 파싱은 0..7로 하고 뒤에서 접는다.
  const dowRaw = parseField(fields[4], 0, 7, DOW_NAMES);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;

  const dow = new Set<number>();
  for (const d of dowRaw.set) dow.add(d === 7 ? 0 : d);

  return {
    minute: sorted(minute.set),
    hour: sorted(hour.set),
    dom: sorted(dom.set),
    month: sorted(month.set),
    dow: sorted(dow),
    domStar: dom.star,
    dowStar: dowRaw.star,
  };
}

function dateMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.month.has(d.getMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getDate());
  const dowOk = spec.dow.has(d.getDay());
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowOk;
  if (spec.dowStar) return domOk;
  return domOk || dowOk;
}

// upTo와 같은 날짜에서 upTo의 시:분 이하로 매칭되는 가장 늦은 시각.
function latestOnDay(spec: CronSpec, upTo: Date): number | null {
  const hours = [...spec.hour].filter((h) => h <= upTo.getHours()).reverse();
  for (const h of hours) {
    const maxMinute = h === upTo.getHours() ? upTo.getMinutes() : 59;
    const minutes = [...spec.minute].filter((m) => m <= maxMinute).reverse();
    if (minutes.length === 0) continue;
    const d = new Date(upTo);
    d.setHours(h, minutes[0], 0, 0);
    return d.getTime();
  }
  return null;
}

// from과 같은 날짜에서 from의 시:분 이상으로 매칭되는 가장 이른 시각.
function earliestOnDay(spec: CronSpec, from: Date): number | null {
  const hours = [...spec.hour].filter((h) => h >= from.getHours());
  for (const h of hours) {
    const minMinute = h === from.getHours() ? from.getMinutes() : 0;
    const minutes = [...spec.minute].filter((m) => m >= minMinute);
    if (minutes.length === 0) continue;
    const d = new Date(from);
    d.setHours(h, minutes[0], 0, 0);
    return d.getTime();
  }
  return null;
}

// at 이하의 가장 최근 예정 시각. 없으면 null.
// 날짜가 안 맞으면 하루씩 건너뛰므로 스캔은 최대 lookbackDays번이다.
export function prevDue(spec: CronSpec, at: number, lookbackDays = 8): number | null {
  const cur = new Date(at);
  cur.setSeconds(0, 0);
  for (let i = 0; i <= lookbackDays; i++) {
    if (dateMatches(spec, cur)) {
      const found = latestOnDay(spec, cur);
      if (found !== null) return found;
    }
    cur.setDate(cur.getDate() - 1);
    cur.setHours(23, 59, 0, 0);
  }
  return null;
}

// from을 넘어서는 첫 예정 시각. 없으면 null.
export function nextDue(spec: CronSpec, from: number, lookaheadDays = 400): number | null {
  const cur = new Date(from);
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1);
  for (let i = 0; i <= lookaheadDays; i++) {
    if (dateMatches(spec, cur)) {
      const found = earliestOnDay(spec, cur);
      if (found !== null) return found;
    }
    cur.setDate(cur.getDate() + 1);
    cur.setHours(0, 0, 0, 0);
  }
  return null;
}

export interface DueArgs {
  spec: CronSpec;
  // 이 잡이 마지막으로 소비한 예정 시각. 실행 시각이 아니다.
  lastFireAt: number | null;
  // 잡이 만들어진 시각. 없으면 오늘 11시가 지난 뒤 잡을 추가했을 때 곧바로 한 번 돈다.
  since: number;
  now: number;
  graceMs: number;
}

// 돌려야 할 예정 시각(fire_at)을 돌려준다. 이 값이 중복 실행을 막는 유일한 키다.
export function isDue(a: DueArgs): number | null {
  const fire = prevDue(a.spec, a.now);
  if (fire === null) return null;
  if (a.now - fire > a.graceMs) return null;
  if (fire < a.since) return null;
  if (a.lastFireAt !== null && a.lastFireAt >= fire) return null;
  return fire;
}

export function renderTemplate(tpl: string, vars: { fireAt: number; jobId: string }): string {
  const d = new Date(vars.fireAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return tpl.replaceAll(/\{(date|job|ts)\}/g, (_m, key: string) =>
    key === "date" ? date : key === "job" ? vars.jobId : String(vars.fireAt)
  );
}
