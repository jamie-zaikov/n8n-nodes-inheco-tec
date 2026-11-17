/**
 * FR-16.6 (amendment A7.1): the README "Emergency Off recovery" section.
 *
 * Ported from the paired API repo, whose suite checked this README from outside (FR-3.4, design
 * C-13): the README states the same single recovery path as the API runbook section 5.11 (Release
 * Controller if connected, power-cycle, then Reacquire Controller) in four numbered points and
 * names Connect only in point 3 (Connect on a `connected` controller is not the documented path).
 * The README is read as text only, so the check needs no build. The assertions are those of the
 * source suite.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const README = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md');
const HEADING = '## Emergency Off recovery';
const POINT_1_LEAD = '**Release Controller if connected, power-cycle, then Reacquire Controller.**';
const POINT = /^(\d+)\. /gm;

function lines(): string[] {
  return readFileSync(README, 'utf8').replace(/\r\n/g, '\n').split('\n');
}

/** The text from the `## Emergency Off recovery` line up to the next `## ` heading. */
function section(): string {
  const all = lines();
  const start = all.indexOf(HEADING);
  expect(start, `the README has the heading ${HEADING}`).toBeGreaterThanOrEqual(0);
  let end = all.length;
  for (let i = start + 1; i < all.length; i += 1) {
    if ((all[i] as string).startsWith('## ')) {
      end = i;
      break;
    }
  }
  return all.slice(start, end).join('\n');
}

/** The four numbered points of the section, each with its continuation lines. */
function points(): string[] {
  const text = section();
  const matches = [...text.matchAll(POINT)];
  expect(matches.map((m) => Number(m[1])), 'expected points numbered 1-4').toEqual([1, 2, 3, 4]);
  const starts = matches.map((m) => m.index as number);
  return starts.map((start, i) => text.slice(start, i + 1 < starts.length ? starts[i + 1] : text.length));
}

function pointBounds(text: string, index: number): [number, number] {
  const point = points()[index] as string;
  const start = text.indexOf(point);
  return [start, start + point.length];
}

describe('README Emergency Off recovery (FR-16.6)', () => {
  it('test_fr16_6_point_1_release_power_cycle_then_reacquire', () => {
    const point = points()[0] as string;
    for (const needed of [
      'Release Controller',
      'Power-cycle the TEC controller',
      'Reacquire Controller',
      'emergency_off_cleared: true',
    ]) {
      expect(point.includes(needed), `point 1 lacks ${needed}`).toBe(true);
    }
    expect(point.startsWith(`1. ${POINT_1_LEAD}`)).toBe(true);
    // The bold lead itself holds "Reacquire Controller": check the order after it (design C16).
    const body = point.slice(point.indexOf(POINT_1_LEAD) + POINT_1_LEAD.length);
    const release = body.indexOf('Release Controller');
    const powerCycle = body.indexOf('Power-cycle the TEC controller');
    const reacquire = body.indexOf('Reacquire Controller');
    expect(release).toBeGreaterThanOrEqual(0);
    expect(release).toBeLessThan(powerCycle);
    expect(powerCycle).toBeLessThan(reacquire);
  });

  it('test_fr16_6_point_2_code_i_502_means_power_cycle_missing', () => {
    const point = points()[1] as string;
    for (const needed of ['502', 'code `I`', 'power cycle is missing']) {
      expect(point.includes(needed), `point 2 lacks ${needed}`).toBe(true);
    }
  });

  it('test_fr16_6_point_3_connect_on_connected_is_not_the_documented_path', () => {
    const point = points()[2] as string;
    for (const needed of ['Connect', '`connected`', 'not the documented path', 'old device handle']) {
      expect(point.includes(needed), `point 3 lacks ${needed}`).toBe(true);
    }
  });

  it('test_fr16_6_point_4_service_restart_is_not_a_recovery_step', () => {
    const point = points()[3] as string;
    for (const needed of ['service restart', 'FR-17.9', 'not a recovery step']) {
      expect(point.includes(needed), `point 4 lacks ${needed}`).toBe(true);
    }
  });

  it('test_fr16_6_connect_appears_only_in_point_3', () => {
    // Case-sensitive: `connected` (state name) and `Controller` do not match.
    const text = section();
    const [start, end] = pointBounds(text, 2);
    const hits = [...text.matchAll(/Connect/g)].map((m) => m.index as number);
    expect(hits.length, 'the section names Connect nowhere (point 3 must)').toBeGreaterThan(0);
    const outside = hits.filter((i) => !(start <= i && i < end));
    expect(outside.map((i) => text.slice(Math.max(0, i - 30), i + 30))).toEqual([]);
    expect(text.includes('Use Connect')).toBe(false);
    expect(text.includes('**Connect**')).toBe(false);
  });
});
