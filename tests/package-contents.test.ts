import { describe, expect, test } from "bun:test";
import packageJson from "../packages/axis-server/package.json";

describe("@virsanghavi/axis-server package contents", () => {
    test("publishes only runtime artifacts and public documentation", () => {
        expect(packageJson.files).toEqual(["dist", "README.md"]);
        expect(packageJson.files).not.toContain(".axis");
        expect(packageJson.files).not.toContain(".axis-server.log");
        expect(packageJson.files).not.toContain("bin");
    });
});
