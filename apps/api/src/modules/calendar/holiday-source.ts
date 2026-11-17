import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface HolidayItem {
    date: string; // 'YYYY-MM-DD'
    name: string;
}

/** 공휴일을 어디서 가져오는지. 테스트에서는 가짜로 바꿔 끼운다 */
export abstract class HolidaySource {
    /** 그 해의 공휴일. 키가 없거나 호출에 실패하면 null */
    abstract fetchYear(year: number): Promise<HolidayItem[] | null>;
}

// 한국천문연구원 특일 정보(공공데이터포털) — 응답 모양은 공식 문서 기준이며, 키를 받으면 실제 응답으로 한 번 확인한다
const KASI_URL = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
const TIMEOUT_MS = 5000;

interface KasiItem {
    dateName?: string;
    isHoliday?: string;
    locdate?: number | string;
}
interface KasiResponse {
    response?: { body?: { items?: string | { item?: KasiItem | KasiItem[] } } };
}

/** 공공데이터포털 응답에서 공휴일(isHoliday=Y)만 뽑는다. 같은 날 둘이면 이름을 이어 붙인다 */
export function parseKasiResponse(json: unknown): HolidayItem[] {
    const items = (json as KasiResponse | null)?.response?.body?.items;
    if (!items || typeof items === 'string') return []; // 결과가 없으면 items가 빈 글자로 온다
    const raw = items.item;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []; // 한 건이면 배열이 아니라 객체로 온다

    const byDate = new Map<string, string>();
    for (const item of list) {
        if (item.isHoliday !== 'Y' || !item.dateName) continue;
        const loc = String(item.locdate ?? '');
        if (!/^\d{8}$/.test(loc)) continue;
        const date = `${loc.slice(0, 4)}-${loc.slice(4, 6)}-${loc.slice(6, 8)}`;
        const prev = byDate.get(date);
        byDate.set(date, prev ? `${prev}, ${item.dateName}` : item.dateName);
    }
    return [...byDate].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date));
}

/** 날짜가 해마다 같은 공휴일만 (음력 명절·대체공휴일은 빠진다). 서비스 키가 없을 때 임시로 쓴다 */
export function fixedHolidays(year: number): HolidayItem[] {
    const fixed: [string, string][] = [
        ['01-01', '신정'],
        ['03-01', '삼일절'],
        ['05-05', '어린이날'],
        ['06-06', '현충일'],
        ['08-15', '광복절'],
        ['10-03', '개천절'],
        ['10-09', '한글날'],
        ['12-25', '성탄절'],
    ];
    return fixed.map(([md, name]) => ({ date: `${year}-${md}`, name }));
}

@Injectable()
export class KasiHolidaySource extends HolidaySource {
    private readonly logger = new Logger(KasiHolidaySource.name);

    constructor(private readonly config: ConfigService) {
        super();
    }

    async fetchYear(year: number): Promise<HolidayItem[] | null> {
        const rawKey = this.config.get<string>('HOLIDAY_API_KEY');
        if (!rawKey) return null; // 키를 아직 못 받은 환경(개발·CI)

        // 포털의 "Encoding" 키는 이미 %가 들어 있어서, 풀어 준 뒤 한 번만 인코딩한다
        const serviceKey = rawKey.includes('%') ? decodeURIComponent(rawKey) : rawKey;
        const query = new URLSearchParams({ serviceKey, solYear: String(year), numOfRows: '100', _type: 'json' });
        try {
            const res = await fetch(`${KASI_URL}?${query.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) {
                this.logger.warn(`공휴일 API 응답 오류 (HTTP ${res.status})`);
                return null;
            }
            return parseKasiResponse(await res.json());
        } catch (error) {
            // 주소에 키가 들어 있어서 오류 객체 대신 이름만 남긴다
            this.logger.warn(`공휴일 API 호출 실패 (${error instanceof Error ? error.name : 'unknown'})`);
            return null;
        }
    }
}
