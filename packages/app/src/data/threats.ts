import type { Threat } from '@anti-air/engine';
import raw from '../../../../data/threats.json';

export const THREATS: Threat[] = (raw as { threats: unknown[] }).threats as Threat[];
export const THREAT_BY_ID = new Map(THREATS.map((t) => [t.id, t]));
export const DEFAULT_THREAT_ID = 'cruise-missile';
