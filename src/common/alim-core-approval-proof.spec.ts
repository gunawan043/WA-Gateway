/**
 * The real-Core approval section is the one place Connect proves, over HTTP, that a WhatsApp reply
 * reaches ALIM Core as a command Core accepts. A real Core never reaches the suite's loopback recorder,
 * so the section cannot read Core's request back the way the mock sections do — it has to read what
 * Connect stored instead, and this file pins each thing it reads.
 *
 * Two of the cases exist because the alternatives are silent: a command the API detail does not return
 * at all (the section would read "no command", not "approved"), and a permit status that is only
 * ALIM's default.
 */
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');

const spec = read('test', 'approval-http.e2e-spec.ts');
const section = spec.slice(spec.indexOf("describe('Z. ALIM Core sungguhan'"));

describe('real-Core approval proof, as the suite reads it', () => {
  it('waits for the command it reads, rather than reading the permit before the reply was answered', () => {
    // The reply hook stores the command, then calls Core. Reading the detail straight after the hook
    // can see the request still PENDING_APPROVAL with no command, which is what a run against a real
    // Core did: the section reported "no command was created" for a permit whose command was on its way.
    expect(section).toContain('await waitForCommand(request.id)');
    // A reply from the mock sections' sender would be refused before Core is called.
    expect(section).toContain('await replyFrom(ACTOR_JID');
    expect(spec).toContain('const waitForCommand = async');
  });

  it('reads the decision from Connect, with the command id it was stored under', () => {
    expect(section).toContain("expect(verdict.status).toBe('APPROVED')");
    expect(section).toContain("expect(verdict.coreStatus).not.toBe('pending')");
    // A permit Core just approved must report Core's own verdict, not ALIM's starting value.
  });

  it('separates "Core refused the actor" from "Core refused the permit"', () => {
    // Both are refusals over a route that works; only one says the actor is mapped.
    expect(section).toContain('actor_identity_unmapped');
    expect(section).toContain("expect(mapped.code ?? '').not.toMatch(/^actor_/)");
  });

  it('checks the actor number is E.164 digits before blaming Core for the refusal', () => {
    expect(section).toContain('actorNumberProblem');
    expect(section).toContain('/^[1-9][0-9]{7,14}$/.test(ACTOR_NUMBER)');
  });
});

describe('the API detail a real-Core run reads', () => {
  it('returns the commands the section counts', () => {
    const dto = read('src', 'modules', 'approval', 'dto', 'approval-command-response.dto.ts');
    expect(dto).toContain('commandId');
  });

  it('reports a command that went to the loopback mock rather than reading it as Core evidence', () => {
    expect(section).toContain('went to the loopback mock, not Core');
    expect(section).toContain('coreCalls.filter(call => call.body?.command_id)');
  });

  it('keeps the actor number and permit person out of the response', () => {
    const dto = read('src', 'modules', 'approval', 'dto', 'approval-response.dto.ts');
    expect(dto).toContain('Field yang sengaja TIDAK ada');
    expect(dto).toContain('`targetIdentity`');
  });
});
