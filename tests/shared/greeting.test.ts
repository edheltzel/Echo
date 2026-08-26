import { describe, expect, test } from "bun:test";
import {
  applyNameToken,
  defaultStartupGreetings,
  NAMED_STARTUP_GREETINGS,
  NAMELESS_STARTUP_GREETINGS,
  personaGreetingFields,
} from "../../shared/greeting.ts";

describe("startup greeting pools", () => {
  test("default pool is the nameless set", () => {
    expect(defaultStartupGreetings()).toEqual(NAMELESS_STARTUP_GREETINGS);
    expect(NAMELESS_STARTUP_GREETINGS).toEqual([
      "standing by",
      "ready when you are",
      "waiting for direction",
      "engaged",
    ]);
  });

  test("sayName selects the named pool", () => {
    expect(defaultStartupGreetings(true)).toEqual(NAMED_STARTUP_GREETINGS);
  });

  test("applyNameToken fills only when sayName is on", () => {
    expect(applyNameToken("{name}, standing by", "Atlas", true)).toBe("Atlas, standing by");
    expect(applyNameToken("{name}, standing by", "Atlas", false)).toBe("standing by");
  });

  test("custom lines without {name} stay verbatim", () => {
    expect(applyNameToken("Atlas, standing by", "Echo", false)).toBe("Atlas, standing by");
    expect(applyNameToken("Atlas, standing by", "Echo", true)).toBe("Atlas, standing by");
  });

  test("personaGreetingFields does not inherit global lines when the project set a name", () => {
    const fields = personaGreetingFields(
      { name: "Echo" },
      { startupCatchphrases: ["Atlas online."] },
    );
    expect(fields.phrases).toBeUndefined();
    expect(fields.sayName).toBeUndefined();
  });

  test("personaGreetingFields keeps inherited lines when the project has no name", () => {
    const fields = personaGreetingFields(
      { voices: { main: { voiceId: "en-US-AndrewNeural" } } },
      { startupCatchphrases: ["Atlas online."] },
    );
    expect(fields.phrases).toEqual(["Atlas online."]);
  });

  test("personaGreetingFields reads sayName from the project layer", () => {
    expect(personaGreetingFields({ sayName: true }, { sayName: false }).sayName).toBe(true);
    expect(personaGreetingFields({}, { sayName: "yes" }).sayName).toBe(true);
  });
});
