// iCalendar（.ics）を読み取って、期間内の予定の一覧にする
//
// 繰り返し予定（RRULE）、除外日（EXDATE）、1回だけ変更した予定（RECURRENCE-ID）、
// 終日の予定、タイムゾーン（VTIMEZONE）に対応する。

import ICAL from "ical.js";

const MAX_EVENTS = 1500;      // 返す予定の上限
const MAX_ITERATIONS = 5000;  // 1つの繰り返し予定をたどる回数の上限

function text(value, max = 200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// 終日の予定は「YYYY-MM-DD」、時刻のある予定は ISO 形式（UTC）
function toOutput(startDate, endDate) {
  if (startDate.isDate) {
    const end = endDate && endDate.compare(startDate) > 0 ? endDate : startDate.clone();
    if (!endDate || endDate.compare(startDate) <= 0) end.adjust(1, 0, 0, 0);
    return { allDay: true, start: startDate.toString(), end: end.toString() }; // end は翌日（含まない）
  }

  const start = startDate.toJSDate();
  const end = endDate && endDate.compare(startDate) > 0 ? endDate.toJSDate() : start;
  return { allDay: false, start: start.toISOString(), end: end.toISOString() };
}

function overlaps(startDate, endDate, rangeStart, rangeEnd) {
  const end = endDate && endDate.compare(startDate) > 0 ? endDate : startDate;
  return startDate.compare(rangeEnd) < 0 && end.compare(rangeStart) >= 0;
}

/**
 * @param {string} icsText  .ics の中身
 * @param {string} from     "YYYY-MM-DD"（この日を含む）
 * @param {string} to       "YYYY-MM-DD"（この日を含む）
 */
export function parseCalendar(icsText, from, to) {
  const root = new ICAL.Component(ICAL.parse(icsText));

  // カレンダーに入っているタイムゾーンを登録する
  root.getAllSubcomponents("vtimezone").forEach(vtimezone => {
    try {
      ICAL.TimezoneService.register(vtimezone);
    } catch (error) {
      // 読めないタイムゾーンは UTC 扱いになるだけ
    }
  });

  const calendarName = text(root.getFirstPropertyValue("x-wr-calname"), 60);
  const rangeStart = ICAL.Time.fromDateString(from);
  const rangeEnd = ICAL.Time.fromDateString(to);
  rangeEnd.adjust(1, 0, 0, 0); // 最終日の終わりまで

  // 同じ UID の「本体」と「1回だけ変更した回」をまとめる
  const masters = new Map();
  const exceptions = [];

  root.getAllSubcomponents("vevent").forEach(vevent => {
    const event = new ICAL.Event(vevent);
    if (!event.uid) return;
    if (event.isRecurrenceException()) {
      exceptions.push(event);
    } else if (!masters.has(event.uid)) {
      masters.set(event.uid, event);
    }
  });

  const orphans = [];
  exceptions.forEach(exception => {
    const master = masters.get(exception.uid);
    if (master) master.relateException(exception);
    else orphans.push(exception);
  });

  const events = [];
  const push = (event, startDate, endDate, key) => {
    if (events.length >= MAX_EVENTS) return;
    if (!overlaps(startDate, endDate, rangeStart, rangeEnd)) return;
    if (String(event.component.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED") return;

    events.push({
      id: key,
      title: text(event.summary) || "（タイトルなし）",
      location: text(event.location),
      ...toOutput(startDate, endDate)
    });
  };

  for (const event of masters.values()) {
    if (!event.startDate) continue;

    if (!event.isRecurring()) {
      push(event, event.startDate, event.endDate, event.uid);
      continue;
    }

    const iterator = event.iterator();
    let next;
    let count = 0;
    while ((next = iterator.next()) && count++ < MAX_ITERATIONS) {
      if (next.compare(rangeEnd) >= 0) break;
      const occurrence = event.getOccurrenceDetails(next);
      push(occurrence.item, occurrence.startDate, occurrence.endDate, `${event.uid}#${next.toString()}`);
    }
  }

  // 本体が見つからない「変更した回」は、単発の予定として扱う
  orphans.forEach(event => {
    if (event.startDate) push(event, event.startDate, event.endDate, `${event.uid}#${event.recurrenceId}`);
  });

  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { name: calendarName, events };
}
