import { mkdir, readFile, writeFile } from "fs/promises";
import * as path from "path";
import { expect, test, vi } from "vitest";
import * as WEBIFC from "web-ifc";
import {
  ELEMENT_TYPES,
  IdSet,
  IfcSplitter,
  IfcSplitterConfig,
  IfcSplitterCrossPartEvent,
  IfcSplitterGroupsEvent,
  IfcSplitterIO,
  IfcSplitterProgressEvent,
  IfcSplitterWarningEvent,
  listIdxByType,
  SPATIAL_TYPES,
} from ".";
import { SingleThreadedFragmentsModel } from "../../FragmentsModels";
import { IfcImporter } from "../../Importers";
import { IfcSplitterNode } from "./node";

const assetDir = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);

const webIfcDir = path.dirname(import.meta.resolve("web-ifc"));

const syntheticIfc = (types: string[]) =>
  [
    "ISO-10303-21;",
    "HEADER;",
    "ENDSEC;",
    "DATA;",
    ...types.map(
      (type, i) => `#${i + 1}=${type}('guid${i + 1}',$,$,$,$,$,$,$);`,
    ),
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");

const syntheticIfcWithWalls = (wallCount: number) =>
  syntheticIfc(new Array<string>(wallCount).fill("IFCWALL"));

interface SinkState {
  text: string;
  closed: boolean;
  aborted: boolean;
}

/**
 * In-memory {@link IfcSplitterIO}. Captures what each output file received and,
 * when `failOnRead` is set, errors that Nth read partway through so the write
 * pass fails while every output sink is still open.
 */
class MemoryIO implements IfcSplitterIO {
  readonly sinks = new Map<string, SinkState>();

  private reads = 0;

  constructor(
    private readonly source: string,
    private readonly failOnRead = 0,
  ) {}

  async readableStream(): Promise<ReadableStream<string>> {
    this.reads += 1;
    const shouldFail = this.reads === this.failOnRead;
    const lines = this.source.split("\n");
    let i = 0;
    return new ReadableStream<string>({
      pull(controller) {
        if (shouldFail && i === 5) {
          controller.error(new Error("read failed"));
          return;
        }
        if (i >= lines.length) {
          controller.close();
          return;
        }
        controller.enqueue(lines[i]);
        i += 1;
      },
    });
  }

  async writableStream(filePath: string): Promise<WritableStream<string>> {
    const state: SinkState = { text: "", closed: false, aborted: false };
    this.sinks.set(filePath, state);
    return new WritableStream<string>({
      write(chunk) {
        state.text += chunk;
      },
      close() {
        state.closed = true;
      },
      abort() {
        state.aborted = true;
      },
    });
  }
}

/** The config the constructor merged with the defaults */
const mergedConfigOf = (config?: IfcSplitterConfig) =>
  // protected field
  // eslint-disable-next-line dot-notation
  new IfcSplitter(new MemoryIO(""), config)["config"];

test.each<[string, readonly string[]]>([
  ["ELEMENT_TYPES", ELEMENT_TYPES],
  ["SPATIAL_TYPES", SPATIAL_TYPES],
])("%s is frozen", (_, types) => {
  const mutable = types as string[];
  const before = [...types];

  expect(Object.isFrozen(types)).toBe(true);
  // Modules are strict mode, so a write to a frozen array throws instead of
  // failing silently.
  expect(() => mutable.push("IFCMYELEMENT")).toThrow(TypeError);
  expect(() => {
    mutable[0] = "IFCMYELEMENT";
  }).toThrow(TypeError);
  expect(() => mutable.pop()).toThrow(TypeError);
  expect(types).toEqual(before);
});

test.each<[string, IfcSplitterConfig | undefined]>([
  ["is omitted", undefined],
  ["is empty", {}],
  [
    "declares its fields out as undefined",
    {
      elementTypes: undefined,
      spatialTypes: undefined,
      listArgIndex: undefined,
    },
  ],
])("config falls back to the defaults when it %s", (_, config) => {
  const merged = mergedConfigOf(config);

  expect(merged.elementTypes).toEqual(new Set(ELEMENT_TYPES));
  expect(merged.spatialTypes).toEqual(new Set(SPATIAL_TYPES));
  expect(merged.listArgIndex).toBe(listIdxByType);
});

test("config overrides only the fields it declares", () => {
  const elementTypes = ["IFCANNOTATION"];
  const listArgIndex = () => 1;

  const merged = mergedConfigOf({ elementTypes, listArgIndex });

  expect(merged.elementTypes).toEqual(new Set(elementTypes));
  expect(merged.listArgIndex).toBe(listArgIndex);
  expect(merged.spatialTypes).toEqual(new Set(SPATIAL_TYPES));
});

// The merged config has to actually reach the passes that use it, so each
// option is checked against the lines it puts in (or keeps out of) the output.
const linesOf = (state: SinkState | undefined) =>
  [...state!.text.matchAll(/^#\d+=\w+/gm)].map(([line]) => line);

test("elementTypes decides what counts as a splittable element", async () => {
  // A made-up type: every IfcProduct is in the defaults. A line that is not an
  // element is not split; it still ends up in the first file (nothing is lost).
  const source = syntheticIfc(["IFCWALL", "IFCMYELEMENT"]);
  const [byDefault, extended] = await Promise.all(
    [undefined, { elementTypes: ["IFCMYELEMENT"] }].map(async (config) => {
      const io = new MemoryIO(source);
      const splitter = new IfcSplitter(io, config);
      let elements = 0;
      splitter.onSplitsResolved.add(({ data }) => {
        elements = data.reduce((sum, d) => sum + d.elementCount, 0);
      });
      await splitter.split("in.ifc", 1, () => "out.ifc");
      return { elements, lines: linesOf(io.sinks.get("out.ifc")) };
    }),
  );

  expect(byDefault.elements).toBe(1);
  expect(extended.elements).toBe(1);
  expect(byDefault.lines).toEqual(["#1=IFCWALL", "#2=IFCMYELEMENT"]);
});

test("ELEMENT_TYPES and SPATIAL_TYPES cover every IfcProduct of every schema", () => {
  // web-ifc exports one numeric constant per entity name; its schema tables
  // list the (transitive) subtypes of each entity per schema.
  const names = new Map<number, string>();
  for (const [name, value] of Object.entries(WEBIFC)) {
    if (/^IFC[A-Z0-9]+$/.test(name) && typeof value === "number") {
      names.set(value, name);
    }
  }
  const subtypesBySchema = Object.values(
    WEBIFC.InheritanceDef as Record<number, Record<number, number[]>>,
  );
  expect(subtypesBySchema.length).toBeGreaterThanOrEqual(3);
  const subtypes = (schema: Record<number, number[]>, code: number) =>
    new Set((schema[code] ?? []).map((c) => names.get(c)!));

  // abstract supertypes of the spatial structure, never instantiated
  const abstract = new Set([
    "IFCSPATIALELEMENT",
    "IFCSPATIALSTRUCTUREELEMENT",
    "IFCEXTERNALSPATIALSTRUCTUREELEMENT",
  ]);
  const missingElements = new Set<string>();
  const missingSpatial = new Set<string>();
  for (const schema of subtypesBySchema) {
    // shared: the spatial structure (except IfcSpace), grids, positioning
    // elements and alignment layouts (IFC4X3)
    const shared = new Set([
      ...subtypes(schema, WEBIFC.IFCSPATIALSTRUCTUREELEMENT),
      ...subtypes(schema, WEBIFC.IFCPOSITIONINGELEMENT),
      ...subtypes(schema, WEBIFC.IFCLINEARELEMENT),
      "IFCPOSITIONINGELEMENT",
      "IFCLINEARELEMENT",
      "IFCGRID",
    ]);
    shared.delete("IFCSPACE");
    for (const name of subtypes(schema, WEBIFC.IFCPRODUCT)) {
      if (abstract.has(name)) continue;
      if (shared.has(name)) {
        if (!SPATIAL_TYPES.includes(name as never)) missingSpatial.add(name);
      } else if (!ELEMENT_TYPES.includes(name as never)) {
        missingElements.add(name);
      }
    }
  }
  expect([...missingElements]).toEqual([]);
  expect([...missingSpatial]).toEqual([]);
});

// Regression: these were missing from ELEMENT_TYPES, so split and extract
// dropped every instance without a warning.
test.each([
  "IFCVALVE",
  "IFCPIPESEGMENT",
  "IFCDUCTFITTING",
  "IFCAIRTERMINAL",
  "IFCREINFORCINGBAR",
  "IFCELEMENTASSEMBLY",
  "IFCFURNITURE",
  "IFCELECTRICDISTRIBUTIONPOINT",
])("split keeps %s", async (type) => {
  const io = new MemoryIO(syntheticIfc(["IFCWALL", type]));
  await new IfcSplitter(io).split(
    "in.ifc",
    2,
    (groupId) => `out_${groupId}.ifc`,
  );

  expect([...io.sinks.values()].map(linesOf).flat().sort()).toEqual(
    ["#1=IFCWALL", `#2=${type}`].sort(),
  );
});

test("split keeps ports in the same file as their element", async () => {
  const source = [
    "ISO-10303-21;",
    "HEADER;",
    "ENDSEC;",
    "DATA;",
    "#1=IFCPIPESEGMENT('guid1',$,$,$,$,$,$,$,$);",
    "#2=IFCPIPESEGMENT('guid2',$,$,$,$,$,$,$,$);",
    "#3=IFCPIPEFITTING('guid3',$,$,$,$,$,$,$,$);",
    "#4=IFCDISTRIBUTIONPORT('guid4',$,$,$,$,$,$,.SINK.,$,$);",
    "#5=IFCDISTRIBUTIONPORT('guid5',$,$,$,$,$,$,.SOURCE.,$,$);",
    // IFC4: ports nested under their element. RelatedObjects is argument 5.
    "#6=IFCRELNESTS('guid6',$,$,$,#1,(#4,#5));",
    "#7=IFCDISTRIBUTIONPORT('guid7',$,$,$,$,$,$,.SINK.,$,$);",
    // IFC2X3: one relationship per port, both arguments single references.
    "#8=IFCRELCONNECTSPORTTOELEMENT('guid8',$,$,$,#7,#2);",
    // A port nested under a type object: the parent is no element, so the
    // relationship can only follow its RelatedObjects.
    "#9=IFCPIPESEGMENTTYPE('guid9',$,$,$,$,$,$,$,$,.NOTDEFINED.);",
    "#10=IFCDISTRIBUTIONPORT('guid10',$,$,$,$,$,$,.SINK.,$,$);",
    "#11=IFCRELNESTS('guid11',$,$,$,#9,(#10));",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split(
    "in.ifc",
    4,
    (groupId) => `out_${groupId}.ifc`,
  );

  const files = [...io.sinks.values()].map(({ text }) => text);
  const fileWith = (line: string) => {
    const matches = files.filter((text) => text.includes(line));
    expect(matches, line).toHaveLength(1);
    return matches[0];
  };

  const nested = fileWith("#4=IFCDISTRIBUTIONPORT");
  expect(nested).toContain("#1=IFCPIPESEGMENT");
  expect(nested).toContain("#5=IFCDISTRIBUTIONPORT");
  expect(nested).toContain("#6=IFCRELNESTS('guid6',$,$,$,#1,(#4,#5));");

  const connected = fileWith("#7=IFCDISTRIBUTIONPORT");
  expect(connected).toContain("#2=IFCPIPESEGMENT");
  // A single reference must stay a single reference, not become `(#7)`.
  expect(connected).toContain(
    "#8=IFCRELCONNECTSPORTTOELEMENT('guid8',$,$,$,#7,#2);",
  );

  const typed = fileWith("#10=IFCDISTRIBUTIONPORT");
  expect(typed).toContain("#9=IFCPIPESEGMENTTYPE");
  expect(typed).toContain("#11=IFCRELNESTS('guid11',$,$,$,#9,(#10));");

  expect(fileWith("#3=IFCPIPEFITTING")).not.toContain("IFCDISTRIBUTIONPORT");
});

test("split keeps elements contained in a space with that space", async () => {
  const source = [
    "ISO-10303-21;",
    "HEADER;",
    "ENDSEC;",
    "DATA;",
    "#1=IFCBUILDINGSTOREY('guid1',$,$,$,$,$,$,$,.ELEMENT.,$);",
    "#2=IFCSPACE('guid2',$,$,$,$,$,$,$,.ELEMENT.,$,$);",
    "#3=IFCFURNITURE('guid3',$,$,$,$,$,$,$,$);",
    "#4=IFCWALL('guid4',$,$,$,$,$,$,$,$);",
    "#5=IFCWALL('guid5',$,$,$,$,$,$,$,$);",
    "#6=IFCRELCONTAINEDINSPATIALSTRUCTURE('guid6',$,$,$,(#3),#2);",
    "#7=IFCRELCONTAINEDINSPATIALSTRUCTURE('guid7',$,$,$,(#4,#5),#1);",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split(
    "in.ifc",
    3,
    (groupId) => `out_${groupId}.ifc`,
  );

  const files = [...io.sinks.values()].map(linesOf);
  expect(files).toHaveLength(3);
  const withSpace = files.filter((lines) => lines.includes("#2=IFCSPACE"));
  expect(withSpace).toHaveLength(1);
  expect(withSpace[0]).toContain("#3=IFCFURNITURE");
  expect(withSpace[0]).toContain("#6=IFCRELCONTAINEDINSPATIALSTRUCTURE");
  // Walls in the storey are still split one by one.
  expect(files.filter((lines) => lines.includes("#4=IFCWALL"))).toHaveLength(1);
  expect(files.find((lines) => lines.includes("#4=IFCWALL"))).not.toContain(
    "#5=IFCWALL",
  );
});

test("IdSet holds more ids than a Set can", () => {
  // V8 caps a Set at 2^24 entries; a group of a large file can exceed that.
  const count = 2 ** 24 + 10;
  const ids = new IdSet(count + 5);
  for (let id = 1; id <= count; id++) ids.add(id);
  ids.add(3); // duplicate
  ids.add(-1); // out of range
  ids.add(count + 6); // out of range

  expect(ids.size).toBe(count);
  expect(ids.has(count)).toBe(true);
  expect(ids.has(0)).toBe(false);
  expect(ids.has(count + 1)).toBe(false);

  const copy = ids.clone();
  copy.add(0);
  expect(copy.size).toBe(count + 1);
  expect(ids.has(0)).toBe(false);

  const small = new IdSet(100);
  for (const id of [64, 3, 31, 32, 0, 100]) small.add(id);
  expect([...small]).toEqual([0, 3, 31, 32, 64, 100]);
});

/** An element whose representation is a chain of `weight` extra lines. */
const heavyElement = (id: number, type: string, weight: number) => {
  const lines = [`#${id}=${type}('guid${id}',$,$,$,$,$,#${id + 1},$,$);`];
  for (let i = 1; i < weight; i++) {
    lines.push(`#${id + i}=IFCCARTESIANPOINT((${i}.,0.,0.),#${id + i + 1});`);
  }
  lines.push(`#${id + weight}=IFCCARTESIANPOINT((0.,0.,0.));`);
  return lines;
};

const ifcOf = (lines: string[]) =>
  [
    "ISO-10303-21;",
    "HEADER;",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");

test("split balances groups by size, not by element count", async () => {
  // By count, the two proxies (1st and 3rd element) would share a group.
  const source = ifcOf([
    ...heavyElement(100, "IFCBUILDINGELEMENTPROXY", 50),
    "#200=IFCWALL('guid200',$,$,$,$,$,$,$,$);",
    ...heavyElement(300, "IFCBUILDINGELEMENTPROXY", 40),
    "#400=IFCWALL('guid400',$,$,$,$,$,$,$,$);",
  ]);
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 2, (g) => `out_${g}.ifc`);

  const files = [...io.sinks.values()].map(linesOf);
  const withProxy = (id: number) =>
    files.findIndex((lines) =>
      lines.includes(`#${id}=IFCBUILDINGELEMENTPROXY`),
    );
  expect(withProxy(100)).not.toBe(-1);
  expect(withProxy(300)).not.toBe(-1);
  expect(withProxy(100)).not.toBe(withProxy(300));
});

test("space coupling never collapses the split into one group", async () => {
  const walls = [1, 2, 3, 4, 5, 6].map(
    (n) => `#${10 + n}=IFCWALL('guid${10 + n}',$,$,$,$,$,$,$,$);`,
  );
  const source = ifcOf([
    "#1=IFCBUILDINGSTOREY('guid1',$,$,$,$,$,$,$,.ELEMENT.,$);",
    "#2=IFCSPACE('guid2',$,$,$,$,$,$,$,.ELEMENT.,$,$);",
    ...walls,
    "#30=IFCRELCONTAINEDINSPATIALSTRUCTURE('guid30',$,$,$,(#11,#12,#13,#14,#15,#16),#2);",
  ]);
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 3, (g) => `out_${g}.ifc`);

  const counts = [...io.sinks.values()].map(
    (state) => linesOf(state).filter((line) => line.endsWith("IFCWALL")).length,
  );
  expect(counts).toHaveLength(3);
  expect(Math.max(...counts)).toBeLessThanOrEqual(2);
});

test("split writes non-element structure members once, with their containment", async () => {
  const source = ifcOf([
    "#1=IFCBUILDINGSTOREY('guid1',$,$,$,$,$,$,$,.ELEMENT.,$);",
    "#2=IFCWALL('guid2',$,$,$,$,$,$,$,$);",
    "#3=IFCWALL('guid3',$,$,$,$,$,$,$,$);",
    "#4=IFCANNOTATION('guid4',$,$,$,$,$,#5,$);",
    "#5=IFCCARTESIANPOINT((0.,0.,0.));",
    "#6=IFCRELCONTAINEDINSPATIALSTRUCTURE('guid6',$,$,$,(#2,#3,#4),#1);",
    // Property set of the storey: the storey is in every file, so is this.
    "#7=IFCPROPERTYSET('guid7',$,'Pset',$,());",
    "#8=IFCRELDEFINESBYPROPERTIES('guid8',$,$,$,(#1),#7);",
    // The annotation shares a property relationship with a wall.
    "#9=IFCPROPERTYSET('guid9',$,'Pset2',$,());",
    "#10=IFCRELDEFINESBYPROPERTIES('guid10',$,$,$,(#3,#4),#9);",
  ]);
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 2, (g) => `out_${g}.ifc`);

  const files = [...io.sinks.values()].map(({ text }) => text);
  expect(files).toHaveLength(2);
  const withAnnotation = files.filter((text) =>
    text.includes("#4=IFCANNOTATION"),
  );
  expect(withAnnotation).toHaveLength(1);
  expect(withAnnotation[0]).toMatch(
    /#6=IFCRELCONTAINEDINSPATIALSTRUCTURE\([^;]*#4[^;]*\);/,
  );
  for (const text of files) {
    expect(text).toContain("#8=IFCRELDEFINESBYPROPERTIES");
    expect(text).toContain("#7=IFCPROPERTYSET");
  }
});

/** Ids a file references but does not define. */
const danglingRefs = (text: string) => {
  const defined = new Set(
    [...text.matchAll(/^#(\d+)=/gm)].map(([, id]) => Number(id)),
  );
  const missing: number[] = [];
  for (const line of text.split("\n")) {
    const body = line.replace(/^#\d+=/, "").replace(/'[^']*'/g, "");
    for (const [, id] of body.matchAll(/#(\d+)/g)) {
      if (!defined.has(Number(id))) missing.push(Number(id));
    }
  }
  return missing;
};

test("split records relationships across files instead of leaving them dangling", async () => {
  const source = ifcOf([
    // two pipes with one port each, connected port to port
    "#1=IFCPIPESEGMENT('guid1',$,$,$,$,$,$,$,$);",
    "#2=IFCDISTRIBUTIONPORT('guid2',$,$,$,$,$,$,.SOURCE.,$,$);",
    "#3=IFCRELNESTS('guid3',$,$,$,#1,(#2));",
    "#4=IFCPIPESEGMENT('guid4',$,$,$,$,$,$,$,$);",
    "#5=IFCDISTRIBUTIONPORT('guid5',$,$,$,$,$,$,.SINK.,$,$);",
    "#6=IFCRELNESTS('guid6',$,$,$,#4,(#5));",
    "#7=IFCRELCONNECTSPORTS('guid7',$,$,$,#2,#5,$);",
    // two walls joined at their ends
    "#10=IFCWALL('guid10',$,$,$,$,$,$,$,$);",
    "#11=IFCWALL('guid11',$,$,$,$,$,$,$,$);",
    "#12=IFCRELCONNECTSPATHELEMENTS('guid12',$,$,$,$,#10,#11,(),(),.ATEND.,.ATSTART.);",
    // a space bounded by a wall
    "#20=IFCSPACE('guid20',$,$,$,$,$,$,$,.ELEMENT.,$,$);",
    "#21=IFCRELSPACEBOUNDARY('guid21',$,$,$,#20,#10,$,.PHYSICAL.,.INTERNAL.);",
  ]);
  const io = new MemoryIO(source);
  const splitter = new IfcSplitter(io);
  const onCrossPart = vi.fn<(event: IfcSplitterCrossPartEvent) => unknown>();
  splitter.onCrossPartRelations.add(onCrossPart);
  await splitter.split("in.ifc", 5, (g) => `out_${g}.ifc`, "relations.json");

  const files = [...io.sinks]
    .filter(([name]) => name.endsWith(".ifc"))
    .map(([, { text }]) => text);
  expect(files.length).toBeGreaterThan(1);
  for (const text of files) expect(danglingRefs(text)).toEqual([]);

  const { relations } = onCrossPart.mock.calls[0][0];
  // One cluster per group here, so all three relationships span two files.
  expect(relations.map((r) => r.expressId)).toEqual([7, 12, 21]);
  for (const id of [7, 12, 21]) {
    expect(
      files.some((text) => text.includes(`\n#${id}=`)),
      `#${id} must not be written`,
    ).toBe(false);
  }
  const ports = relations[0];
  expect(ports.type).toBe("IFCRELCONNECTSPORTS");
  expect(ports.guid).toBe("guid7");
  expect(ports.ends.map(({ attribute, guid }) => [attribute, guid])).toEqual([
    [4, "guid2"],
    [5, "guid5"],
  ]);
  expect(new Set(ports.ends.map((e) => e.groupId)).size).toBe(2);
  expect(relations[2].ends.map((e) => e.type)).toEqual(["IFCSPACE", "IFCWALL"]);

  const json = JSON.parse(io.sinks.get("relations.json")!.text);
  expect(json.format).toBe("ifc-splitter-cross-part-relations");
  expect(json.relations).toEqual(JSON.parse(JSON.stringify(relations)));
  expect(Object.keys(json.parts)).toHaveLength(files.length);
});

test("split keeps a connection whose elements share a file", async () => {
  const source = ifcOf([
    "#10=IFCWALL('guid10',$,$,$,$,$,$,$,$);",
    "#11=IFCWALL('guid11',$,$,$,$,$,$,$,$);",
    "#12=IFCRELCONNECTSPATHELEMENTS('guid12',$,$,$,$,#10,#11,(),(),.ATEND.,.ATSTART.);",
  ]);
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 1, () => "out.ifc");
  expect(linesOf(io.sinks.get("out.ifc"))).toContain(
    "#12=IFCRELCONNECTSPATHELEMENTS",
  );
});

test("split keeps entities that only reference backwards into every file that holds their target", async () => {
  const source = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    "#1=IFCPROJECT('guid1',$,$,$,$,$,$,(#2),$);",
    "#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#3,$);",
    "#3=IFCAXIS2PLACEMENT3D(#4,$,$);",
    "#4=IFCCARTESIANPOINT((0.,0.,0.));",
    // georeferencing: points at the context, nothing points at it
    "#5=IFCMAPCONVERSION(#2,#6,1000.,2000.,0.,$,$,$);",
    "#6=IFCPROJECTEDCRS('EPSG:25832',$,$,$,$,$,$);",
    "#10=IFCWALL('guid10',$,$,$,$,$,#11,$,$);",
    "#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));",
    "#12=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#13));",
    "#13=IFCTRIANGULATEDFACESET(#14,$,$,((1,2,3)),$);",
    "#14=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));",
    "#15=IFCINDEXEDCOLOURMAP(#13,$,#16,(1));",
    "#16=IFCCOLOURRGBLIST(((1.,0.,0.)));",
    "#20=IFCWALL('guid20',$,$,$,$,$,#21,$,$);",
    "#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));",
    "#22=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#23));",
    "#23=IFCTRIANGULATEDFACESET(#14,$,$,((1,2,3)),$);",
    // one layer for both walls: each file gets it with its own representation
    "#30=IFCPRESENTATIONLAYERASSIGNMENT('Walls',$,(#12,#22),$);",
    // a material associated with the walls' type object only
    "#40=IFCWALLTYPE('guid40',$,$,$,$,$,$,$,$,.STANDARD.);",
    "#41=IFCRELDEFINESBYTYPE('guid41',$,$,$,(#10,#20),#40);",
    "#42=IFCMATERIAL('Concrete',$,$);",
    "#43=IFCRELASSOCIATESMATERIAL('guid43',$,$,$,(#40),#42);",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 2, (g) => `out_${g}.ifc`);

  const files = [...io.sinks.values()].map(({ text }) => text);
  expect(files).toHaveLength(2);
  for (const text of files) {
    expect(text).toContain("#5=IFCMAPCONVERSION");
    expect(text).toContain("#6=IFCPROJECTEDCRS");
    expect(text).toContain("#43=IFCRELASSOCIATESMATERIAL");
    expect(danglingRefs(text)).toEqual([]);
  }
  const first = files.find((text) => text.includes("#10=IFCWALL"))!;
  const second = files.find((text) => text.includes("#20=IFCWALL"))!;
  expect(first).toContain("#15=IFCINDEXEDCOLOURMAP");
  expect(second).not.toContain("#15=IFCINDEXEDCOLOURMAP");
  expect(first).toContain(
    "#30=IFCPRESENTATIONLAYERASSIGNMENT('Walls',$,(#12),$);",
  );
  expect(second).toContain(
    "#30=IFCPRESENTATIONLAYERASSIGNMENT('Walls',$,(#22),$);",
  );
});

test("split and extract ignore comments in the data section", async () => {
  const source = ifcOf([
    "/* the first wall ------------------------------------------------- */",
    "#1=IFCWALL('guid1',$,$,$,$,$,$,$,$); /* trailing comment with #99 */",
    "/* a comment spanning",
    "   two lines */",
    "#2=IFCWALL('guid2',$,'/* not a comment */',$,$,$,$,$,$);",
  ]);
  const io = new MemoryIO(source);
  const splitter = new IfcSplitter(io);
  await splitter.split("in.ifc", 2, (g) => `out_${g}.ifc`);
  const lines = [...io.sinks.values()].map(({ text }) => text).join("\n");
  expect(lines).toContain("#1=IFCWALL('guid1',$,$,$,$,$,$,$,$);");
  expect(lines).toContain(
    "#2=IFCWALL('guid2',$,'/* not a comment */',$,$,$,$,$,$);",
  );
  expect(lines).not.toContain("#99");

  const extracted = await splitter.extract("in.ifc", [2], "one.ifc");
  expect([...extracted]).toEqual([2]);
});

test("split keeps objects that no group takes in the first file", async () => {
  // A type nobody uses, and a file without a single element.
  const withElements = ifcOf([
    "#1=IFCWALL('guid1',$,$,$,$,$,$,$,$);",
    "#2=IFCWALL('guid2',$,$,$,$,$,$,$,$);",
    "#3=IFCSLABTYPE('0kF4yZzbX2Ae7hJIuV0q3w',$,'Unused',$,$,$,$,$,$,.FLOOR.);",
  ]);
  const io = new MemoryIO(withElements);
  await new IfcSplitter(io).split("in.ifc", 2, (g) => `out_${g}.ifc`);
  expect(linesOf(io.sinks.get("out_0.ifc"))).toContain("#3=IFCSLABTYPE");
  expect(linesOf(io.sinks.get("out_1.ifc"))).not.toContain("#3=IFCSLABTYPE");

  const library = ifcOf([
    "#1=IFCPROJECT('2bVxXH1mP0VhQ4f1q_Ji4N',$,$,$,$,$,$,$,$);",
    "#2=IFCWALLTYPE('1lMLB0SQ93WAuUz8n0FVrW',$,'Library type',$,$,$,$,$,$,.STANDARD.);",
  ]);
  const io2 = new MemoryIO(library);
  const result = await new IfcSplitter(io2).split(
    "in.ifc",
    2,
    (g) => `out_${g}.ifc`,
  );
  expect([...result.keys()]).toEqual([0]);
  expect(linesOf(io2.sinks.get("out_0.ifc"))).toEqual([
    "#1=IFCPROJECT",
    "#2=IFCWALLTYPE",
  ]);
});

test("split filters IfcRelDeclares by its definitions and keeps IfcRelServicesBuildings everywhere", async () => {
  const source = ifcOf([
    "#1=IFCPROJECT('guid1',$,$,$,$,$,$,$,$);",
    "#2=IFCBUILDING('guid2',$,$,$,$,$,$,$,.ELEMENT.,$,$,$);",
    "#10=IFCWALL('guid10',$,$,$,$,$,$,$,$);",
    "#11=IFCWALLTYPE('guid11',$,'A',$,$,$,$,$,$,.STANDARD.);",
    "#12=IFCRELDEFINESBYTYPE('guid12',$,$,$,(#10),#11);",
    "#20=IFCSLAB('guid20',$,$,$,$,$,$,$,$);",
    "#21=IFCSLABTYPE('guid21',$,'B',$,$,$,$,$,$,.FLOOR.);",
    "#22=IFCRELDEFINESBYTYPE('guid22',$,$,$,(#20),#21);",
    // RelatedDefinitions is argument 5
    "#30=IFCRELDECLARES('guid30',$,$,$,#1,(#11,#21));",
    "#40=IFCSYSTEM('guid40',$,'Heating',$,$);",
    "#41=IFCRELASSIGNSTOGROUP('guid41',$,$,$,(#20),$,#40);",
    // RelatedBuildings is argument 5
    "#42=IFCRELSERVICESBUILDINGS('guid42',$,$,$,#40,(#2));",
  ]);
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 2, (g) => `out_${g}.ifc`);
  const files = [...io.sinks.values()].map(({ text }) => text);
  const wall = files.find((text) => text.includes("#10=IFCWALL"))!;
  const slab = files.find((text) => text.includes("#20=IFCSLAB"))!;
  expect(wall).not.toBe(slab);
  expect(wall).toContain("#30=IFCRELDECLARES('guid30',$,$,$,#1,(#11));");
  expect(wall).not.toContain("#21=IFCSLABTYPE");
  expect(slab).toContain("#30=IFCRELDECLARES('guid30',$,$,$,#1,(#21));");
  expect(slab).toContain("#42=IFCRELSERVICESBUILDINGS");
  for (const text of files) expect(danglingRefs(text)).toEqual([]);
});

test("split follows chains of non-element objects regardless of line order", async () => {
  // Listed in reverse: the property set of the superior system comes first,
  // the relationship that brings that system in second.
  const source = ifcOf([
    "#1=IFCPROPERTYSET('guid1',$,'Pset_System',$,());",
    "#2=IFCRELDEFINESBYPROPERTIES('guid2',$,$,$,(#21),#1);",
    "#3=IFCRELAGGREGATES('guid3',$,$,$,#21,(#20));",
    "#4=IFCRELASSIGNSTOGROUP('guid4',$,$,$,(#10,#11),$,#20);",
    "#10=IFCPIPESEGMENT('guid10',$,$,$,$,$,$,$,$);",
    "#11=IFCPIPESEGMENT('guid11',$,$,$,$,$,$,$,$);",
    "#20=IFCDISTRIBUTIONSYSTEM('guid20',$,'Branch',$,$,$,$);",
    "#21=IFCDISTRIBUTIONSYSTEM('guid21',$,'Main',$,$,$,$);",
  ]);
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 2, (g) => `out_${g}.ifc`);
  // Both pipes, and so both files, belong to the system hierarchy.
  for (const state of io.sinks.values()) {
    expect(linesOf(state)).toEqual(
      expect.arrayContaining([
        "#21=IFCDISTRIBUTIONSYSTEM",
        "#3=IFCRELAGGREGATES",
        "#2=IFCRELDEFINESBYPROPERTIES",
        "#1=IFCPROPERTYSET",
      ]),
    );
  }
});

test("split writes a relationship in the file of its single end even if it spans files elsewhere", async () => {
  const source = ifcOf([
    "#1=IFCPIPESEGMENT('guid1',$,$,$,$,$,$,$,$);",
    "#2=IFCVALVE('guid2',$,$,$,$,$,$,$,$);",
    // heavier than pipe and valve #2 together, so its file comes first
    "#3=IFCVALVE('guid3',$,$,$,$,$,#30,$,$);",
    "#30=IFCCARTESIANPOINT((1.,0.,0.),#31);",
    "#31=IFCCARTESIANPOINT((2.,0.,0.),#32);",
    "#32=IFCCARTESIANPOINT((3.,0.,0.));",
    // both valves control the pipe; the pipe and valve #2 share a file
    "#4=IFCRELFLOWCONTROLELEMENTS('guid4',$,$,$,(#2,#3),#1);",
    // keeps pipe and valve #2 in one file
    "#5=IFCRELAGGREGATES('guid5',$,$,$,#1,(#2));",
  ]);
  const io = new MemoryIO(source);
  const splitter = new IfcSplitter(io);
  const onCrossPart = vi.fn<(event: IfcSplitterCrossPartEvent) => unknown>();
  splitter.onCrossPartRelations.add(onCrossPart);
  await splitter.split("in.ifc", 2, (g) => `out_${g}.ifc`);
  const files = [...io.sinks.values()].map(({ text }) => text);
  const withPipe = files.find((text) => text.includes("#1=IFCPIPESEGMENT"))!;
  expect(withPipe).toContain("#2=IFCVALVE");
  expect(withPipe).toContain(
    "#4=IFCRELFLOWCONTROLELEMENTS('guid4',$,$,$,(#2),#1);",
  );
  expect(
    onCrossPart.mock.calls[0][0].relations.map((r) => r.expressId),
  ).toEqual([4]);
});

test("split attaches currency and material classification relationships (IFC4)", async () => {
  const source = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    "#1=IFCWALL('guid1',$,$,$,$,$,$,$,$);",
    "#2=IFCMATERIAL('Concrete',$,$);",
    "#3=IFCRELASSOCIATESMATERIAL('guid3',$,$,$,(#1),#2);",
    "#4=IFCCLASSIFICATIONREFERENCE($,'C30',$,$,$,$);",
    "#5=IFCMATERIALCLASSIFICATIONRELATIONSHIP((#4),#2);",
    "#6=IFCCOSTVALUE($,$,$,$,$,$,$,$,$,$);",
    "#7=IFCMONETARYUNIT('EUR');",
    "#8=IFCMONETARYUNIT('CHF');",
    "#9=IFCUNITASSIGNMENT((#7));",
    "#10=IFCPROJECT('guid10',$,$,$,$,$,$,$,#9);",
    "#11=IFCCURRENCYRELATIONSHIP($,$,#7,#8,0.95,$,$);",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 1, () => "out.ifc");
  expect(linesOf(io.sinks.get("out.ifc"))).toEqual(
    expect.arrayContaining([
      "#5=IFCMATERIALCLASSIFICATIONRELATIONSHIP",
      "#11=IFCCURRENCYRELATIONSHIP",
    ]),
  );
});

test("split records space boundaries whose corresponding boundary lies in another file", async () => {
  const source = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    "#1=IFCSPACE('guid1',$,$,$,$,$,$,$,.ELEMENT.,$,$);",
    "#2=IFCSPACE('guid2',$,$,$,$,$,$,$,.ELEMENT.,$,$);",
    "#3=IFCWALL('guid3',$,$,$,$,$,$,$,$);",
    // keeps space 1 and the wall in one file
    "#4=IFCRELAGGREGATES('guid4',$,$,$,#1,(#3));",
    "#10=IFCRELSPACEBOUNDARY2NDLEVEL('guid10',$,$,$,#1,#3,#20,.PHYSICAL.,.INTERNAL.,$,#11);",
    "#11=IFCRELSPACEBOUNDARY2NDLEVEL('guid11',$,$,$,#2,#3,#21,.PHYSICAL.,.INTERNAL.,$,#10);",
    "#20=IFCCONNECTIONSURFACEGEOMETRY(#22,$);",
    "#21=IFCCONNECTIONSURFACEGEOMETRY(#22,$);",
    "#22=IFCCARTESIANPOINT((0.,0.,0.));",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");
  const io = new MemoryIO(source);
  const splitter = new IfcSplitter(io);
  const onCrossPart = vi.fn<(event: IfcSplitterCrossPartEvent) => unknown>();
  splitter.onCrossPartRelations.add(onCrossPart);
  await splitter.split("in.ifc", 2, (g) => `out_${g}.ifc`);
  const files = [...io.sinks.values()].map(({ text }) => text);
  expect(files).toHaveLength(2);
  for (const text of files) expect(danglingRefs(text)).toEqual([]);

  const { relations } = onCrossPart.mock.calls[0][0];
  expect(relations.map((r) => r.expressId)).toEqual([10, 11]);
  expect(relations[0].references).toEqual([
    {
      attribute: 10,
      guid: "guid11",
      expressId: 11,
      type: "IFCRELSPACEBOUNDARY2NDLEVEL",
    },
  ]);
  expect(relations[0].subgraph).toEqual([
    "#20=IFCCONNECTIONSURFACEGEOMETRY(#22,$);",
    "#22=IFCCARTESIANPOINT((0.,0.,0.));",
  ]);
});

test("split keeps elements that reference each other directly in one file", async () => {
  // IFC2X3 IfcStructuralAction.CausedBy points at a reaction
  const source = ifcOf([
    "#1=IFCSTRUCTURALPOINTREACTION('guid1',$,$,$,$,$,$,$,$,.LOCAL_COORDS.);",
    "#2=IFCSTRUCTURALPOINTACTION('guid2',$,$,$,$,$,$,$,$,.LOCAL_COORDS.,.F.,#1);",
    "#3=IFCWALL('guid3',$,$,$,$,$,$,$,$);",
  ]);
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 3, (g) => `out_${g}.ifc`);
  const files = [...io.sinks.values()].map(({ text }) => text);
  for (const text of files) expect(danglingRefs(text)).toEqual([]);
  expect(files.some((t) => t.includes("#1=") && t.includes("#2="))).toBe(true);
});

test("split writes positioning elements and IfcRelPositions into every file", async () => {
  const source = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_SCHEMA(('IFC4X3_ADD2'));",
    "ENDSEC;",
    "DATA;",
    "#1=IFCREFERENT('guid1',$,$,$,$,$,$,.STATION.);",
    "#10=IFCWALL('guid10',$,$,$,$,$,$,$,$);",
    "#11=IFCWALL('guid11',$,$,$,$,$,$,$,$);",
    "#20=IFCRELPOSITIONS('guid20',$,$,$,#1,(#10,#11));",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");
  const io = new MemoryIO(source);
  const splitter = new IfcSplitter(io);
  const onCrossPart = vi.fn<(event: IfcSplitterCrossPartEvent) => unknown>();
  splitter.onCrossPartRelations.add(onCrossPart);
  await splitter.split("in.ifc", 2, (g) => `out_${g}.ifc`);
  const files = [...io.sinks.values()].map(({ text }) => text);
  expect(files).toHaveLength(2);
  for (const text of files) {
    expect(text).toContain("#1=IFCREFERENT");
    expect(text).toMatch(
      /#20=IFCRELPOSITIONS\('guid20',\$,\$,\$,#1,\(#1[01]\)\);/,
    );
  }
  expect(onCrossPart.mock.calls[0][0].relations).toEqual([]);
});

test("IfcSplitterNode copies bytes unchanged, whatever the text encoding", async () => {
  // ISO 10303-21 wants ASCII, but exporters write raw UTF-8 and ISO 8859-1.
  const dir = path.resolve(__dirname, ".tmp", "encoding");
  await mkdir(dir, { recursive: true });
  const input = path.join(dir, "in.ifc");
  const latin1Name = Buffer.from([0x47, 0x65, 0x6c, 0xe4, 0x6e, 0x64, 0x65]); // "Gelände" in ISO 8859-1
  const utf8Name = Buffer.from("Gelände", "utf8");
  const source = Buffer.concat([
    Buffer.from(
      "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCWALL('guid1',$,'",
    ),
    latin1Name,
    Buffer.from("',$,$,$,$,$,$);\n#2=IFCWALL('guid2',$,'"),
    utf8Name,
    Buffer.from("',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n"),
  ]);
  await writeFile(input, source);
  const output = path.join(dir, "out.ifc");
  await new IfcSplitterNode().split(input, 1, () => output);
  const written = await readFile(output);
  expect(written.includes(Buffer.from([0x27, ...latin1Name, 0x27]))).toBe(true);
  expect(written.includes(Buffer.concat([Buffer.from("'"), utf8Name]))).toBe(
    true,
  );
});

test("a layer keeps representations that only the first file takes as leftovers", async () => {
  const source = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    "#1=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$);",
    "#2=IFCWALL('guid2',$,$,$,$,$,#3,$,$);",
    "#3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));",
    "#4=IFCSHAPEREPRESENTATION(#1,'Body','Brep',());",
    // a representation nothing uses, but on the layer
    "#5=IFCSHAPEREPRESENTATION(#1,'Body','Brep',());",
    "#6=IFCPRESENTATIONLAYERASSIGNMENT('Layer',$,(#4,#5),$);",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 1, () => "out.ifc");
  expect(io.sinks.get("out.ifc")!.text).toContain(
    "#6=IFCPRESENTATIONLAYERASSIGNMENT('Layer',$,(#4,#5),$);",
  );
});

test("relationships of the first file are widened by its leftovers", async () => {
  const source = ifcOf([
    "#1=IFCPIPESEGMENT('guid1',$,$,$,$,$,$,$,$);",
    "#2=IFCDISTRIBUTIONSYSTEM('guid2',$,'System',$,$,$,$);",
    "#3=IFCRELASSIGNSTOGROUP('guid3',$,$,$,(#1),$,#2);",
    // a zone nothing else refers to, grouped with the system
    "#4=IFCZONE('guid4',$,'Zone',$,$,$);",
    "#5=IFCGROUP('guid5',$,'Gruppe',$,$);",
    "#6=IFCRELASSIGNSTOGROUP('guid6',$,$,$,(#2,#4),$,#5);",
  ]);
  const io = new MemoryIO(source);
  await new IfcSplitter(io).split("in.ifc", 1, () => "out.ifc");
  expect(io.sinks.get("out.ifc")!.text).toContain(
    "#6=IFCRELASSIGNSTOGROUP('guid6',$,$,$,(#2,#4),$,#5);",
  );
});

test("spatialTypes decides what is shared across every group", async () => {
  const source = syntheticIfc(["IFCWALL", "IFCWALL", "IFCBUILDINGSTOREY"]);
  const [byDefault, none] = await Promise.all(
    [undefined, { spatialTypes: [] }].map(async (config) => {
      const io = new MemoryIO(source);
      await new IfcSplitter(io, config).split(
        "in.ifc",
        2,
        (groupId) => `out_${groupId}.ifc`,
      );
      return [...io.sinks.values()].map(linesOf);
    }),
  );

  expect(byDefault).toEqual([
    ["#1=IFCWALL", "#3=IFCBUILDINGSTOREY"],
    ["#2=IFCWALL", "#3=IFCBUILDINGSTOREY"],
  ]);
  // not shared: the storey is no longer in every file, only in the first
  expect(none).toEqual([
    ["#1=IFCWALL", "#3=IFCBUILDINGSTOREY"],
    ["#2=IFCWALL"],
  ]);
});

test("listArgIndex returning undefined skips the type entirely", async () => {
  const source = [
    "ISO-10303-21;",
    "HEADER;",
    "ENDSEC;",
    "DATA;",
    "#1=IFCWALL('guid1',$,$,$,$,$,$,$);",
    "#2=IFCPROPERTYSET('guid2',$,'Pset',$,(#3));",
    "#3=IFCPROPERTYSINGLEVALUE('P',$,IFCLABEL('v'),$);",
    "#4=IFCRELDEFINESBYPROPERTIES('guid4',$,$,$,(#1),#2);",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");
  const [byDefault, skipped] = await Promise.all(
    [
      undefined,
      {
        // Delegating to the exported default for everything else.
        listArgIndex: (ifcType: string) =>
          ifcType === "IFCRELDEFINESBYPROPERTIES"
            ? undefined
            : listIdxByType(ifcType),
      },
    ].map(async (config) => {
      const io = new MemoryIO(source);
      await new IfcSplitter(io, config).split("in.ifc", 1, () => "out.ifc");
      return linesOf(io.sinks.get("out.ifc"));
    }),
  );

  expect(byDefault).toEqual([
    "#1=IFCWALL",
    "#2=IFCPROPERTYSET",
    "#3=IFCPROPERTYSINGLEVALUE",
    "#4=IFCRELDEFINESBYPROPERTIES",
  ]);
  // A relationship that is not rewritten is not filtered per file; as a line no
  // group took it still goes, unchanged, into the first file.
  expect(skipped).toEqual(byDefault);
});

test("split releases every output writer when the write pass fails", async () => {
  const io = new MemoryIO(syntheticIfcWithWalls(2), 2);
  const splitter = new IfcSplitter(io);

  await expect(
    splitter.split("in.ifc", 2, (groupId) => `out_${groupId}.ifc`),
  ).rejects.toThrow("read failed");

  expect(io.sinks.size).toBe(2);
  for (const [name, state] of io.sinks) {
    expect(state.aborted, `${name} aborted`).toBe(true);
    expect(state.closed, `${name} closed`).toBe(false);
  }
});

test("extract releases the output writer when the write pass fails", async () => {
  const io = new MemoryIO(syntheticIfcWithWalls(2), 2);
  const splitter = new IfcSplitter(io);

  await expect(splitter.extract("in.ifc", [1], "out.ifc")).rejects.toThrow(
    "read failed",
  );

  expect(io.sinks.get("out.ifc")?.aborted).toBe(true);
  expect(io.sinks.get("out.ifc")?.closed).toBe(false);
});

// Regression: `collectDeps` marked an id visited BEFORE looking up its refs, so
// an id that is only ever referenced — never defined by a line of its own — was
// reported in the group's id set. It cannot be, since nothing is written for it.
test("split never reports an id the source does not define", async () => {
  const source = [
    "ISO-10303-21;",
    "HEADER;",
    "ENDSEC;",
    "DATA;",
    // Dangling reference: no line defines #999.
    "#1=IFCWALL('guid1',$,$,$,$,#999,$,$);",
    // '#' inside a quoted string, which the ref scanner reads as a reference.
    "#2=IFCWALL('guid2 (see #99999)',$,$,$,$,$,$,$);",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");
  const defined = new Set(
    [...source.matchAll(/^#(\d+)=/gm)].map((m) => Number(m[1])),
  );
  const io = new MemoryIO(source);
  const splitter = new IfcSplitter(io);

  const splitMap = await splitter.split(
    "in.ifc",
    2,
    (groupId) => `out_${groupId}.ifc`,
  );

  expect(splitMap.size).toBe(2);
  for (const [groupId, { ids }] of splitMap) {
    const undefined_ = [...ids].filter((id) => !defined.has(id));
    expect(undefined_, `group ${groupId} reports undefined ids`).toEqual([]);
  }
});

// Regression: group membership used to live in a `1 << g` bitmask over a
// Uint32Array, so group 32 aliased group 0, group 33 aliased group 1, and so
// on — silently duplicating elements into the wrong output files.
test.each([1, 32, 33, 64, 100])(
  "split into %i groups keeps every group distinct",
  async (numGroups) => {
    const io = new MemoryIO(syntheticIfcWithWalls(numGroups));
    const splitter = new IfcSplitter(io);

    const splitMap = await splitter.split(
      "in.ifc",
      numGroups,
      (groupId) => `out_${groupId}.ifc`,
    );

    expect(splitMap.size).toBe(numGroups);
    expect(io.sinks.size).toBe(numGroups);

    // One wall per group, and each wall lands in exactly one output file.
    const owners = new Map<number, string[]>();
    for (const [name, state] of io.sinks) {
      expect(state.closed, `${name} closed`).toBe(true);
      const walls = [...state.text.matchAll(/^#(\d+)=IFCWALL/gm)].map((m) =>
        Number(m[1]),
      );
      expect(walls, `${name} wall count`).toHaveLength(1);
      const existing = owners.get(walls[0]) ?? [];
      owners.set(walls[0], [...existing, name]);
    }

    expect(owners.size, "every wall assigned exactly once").toBe(numGroups);
    for (const [wall, files] of owners) {
      expect(files, `#${wall} owners`).toHaveLength(1);
    }
  },
);

// More groups requested than there are element clusters: the surplus groups
// yield no GroupData and no output file at all. `groupId` — not the array
// index — is what ties an entry back to the requested group.
test("split into more groups than clusters skips the empty ones", async () => {
  const wallCount = 3;
  const numGroups = 10;
  const io = new MemoryIO(syntheticIfcWithWalls(wallCount));
  const splitter = new IfcSplitter(io);
  const onSplitsResolved = vi.fn<(event: IfcSplitterGroupsEvent) => unknown>();
  splitter.onSplitsResolved.add(onSplitsResolved);

  const splitMap = await splitter.split(
    "in.ifc",
    numGroups,
    (groupId) => `out_${groupId}.ifc`,
  );

  const { data } = onSplitsResolved.mock.calls[0][0];

  // No null padding out to numGroups, and no file for the empty groups.
  expect(data).toHaveLength(wallCount);
  expect(data.every((group) => group !== null)).toBe(true);
  expect(splitMap.size).toBe(wallCount);
  expect(io.sinks.size).toBe(wallCount);

  // Each entry still knows which requested group it came from.
  expect(data.map(({ groupId }) => groupId)).toEqual([0, 1, 2]);
  for (const group of data) {
    expect(group.filePath, `groupId ${group.groupId}`).toBe(
      `out_${group.groupId}.ifc`,
    );
    expect(io.sinks.get(group.filePath)?.closed).toBe(true);
  }

  // The surplus groups produced nothing at all.
  for (let g = wallCount; g < numGroups; g++) {
    expect(io.sinks.has(`out_${g}.ifc`), `out_${g}.ifc`).toBe(false);
  }
});

test.each([0, -1, 1.5, NaN])(
  "split rejects numGroups=%s",
  async (numGroups) => {
    const splitter = new IfcSplitterNode();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readableStream = vi.spyOn((splitter as any).io, "readableStream");
    await expect(
      splitter.split(
        path.resolve(assetDir, "resources/ifc/school_str.ifc"),
        numGroups,
        () => path.resolve(import.meta.dirname, ".tmp", "unreachable.ifc"),
      ),
    ).rejects.toThrow(RangeError);
    // rejected before any I/O happened
    expect(readableStream).not.toHaveBeenCalled();
  },
);

test("split ifc", async () => {
  const splitter = new IfcSplitterNode();
  const inputPath = path.resolve(assetDir, "resources/ifc/school_str.ifc");
  const onProgress = vi.fn<(event: IfcSplitterProgressEvent) => unknown>();
  const onSplitsResolved = vi.fn<(event: IfcSplitterGroupsEvent) => unknown>();
  const onExtractWarning = vi.fn<(event: IfcSplitterWarningEvent) => unknown>();
  splitter.onProgress.add(onProgress);
  splitter.onSplitsResolved.add(onSplitsResolved);
  splitter.onExtractWarning.add(onExtractWarning);
  const splitCount = 10;
  const splitMap = await splitter.split(inputPath, splitCount, (groupId) =>
    path.resolve(
      __dirname,
      ".tmp",
      `split_${String(groupId + 1).padStart(3, "0")}.ifc`,
    ),
  );

  expect(onProgress.mock.calls.map(([{ stage }]) => stage)).toEqual([
    "parse",
    "spatial",
    "void-fill",
    "style-maps",
    "classify",
    "aggregate",
    "cluster",
    "distribute",
    "relations",
    "resolve",
    "build-index",
    "write",
  ]);
  expect(onSplitsResolved).toHaveBeenCalledOnce();

  const { data } = onSplitsResolved.mock.calls[0][0];
  // Every group is non-empty here, so groupId matches position 1:1.
  expect(data.map(({ groupId }) => groupId)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
  expect(
    data.map(({ elementCount, totalIds, rewrittenLines }) => {
      return { elementCount, totalIds, rewrittenLines: rewrittenLines.size };
    }),
  ).toEqual([
    {
      elementCount: 152,
      rewrittenLines: 555,
      totalIds: 10402,
    },
    {
      elementCount: 147,
      rewrittenLines: 545,
      totalIds: 9277,
    },
    {
      elementCount: 155,
      rewrittenLines: 579,
      totalIds: 9367,
    },
    {
      elementCount: 160,
      rewrittenLines: 595,
      totalIds: 11522,
    },
    {
      elementCount: 155,
      rewrittenLines: 577,
      totalIds: 9361,
    },
    {
      elementCount: 154,
      rewrittenLines: 577,
      totalIds: 9376,
    },
    {
      elementCount: 159,
      rewrittenLines: 583,
      totalIds: 9405,
    },
    {
      elementCount: 159,
      rewrittenLines: 583,
      totalIds: 9408,
    },
    {
      elementCount: 155,
      rewrittenLines: 578,
      totalIds: 9356,
    },
    {
      elementCount: 155,
      rewrittenLines: 574,
      totalIds: 9364,
    },
  ]);

  expect(onExtractWarning).not.toHaveBeenCalled();

  expect(splitMap.size).toBe(splitCount);
  for (const { groupId, filePath, fileIds } of data) {
    expect(splitMap.get(groupId), filePath).toEqual({
      path: filePath,
      ids: fileIds,
    });
  }
}, 60_000);

// Regression: extract used to resolve dependencies (including resolveStyles)
// before rewriting relationship lines. Entities pulled into the output only by
// the relations pass therefore never got their presentation styles resolved:
// their IfcStyledItem bindings — and the style chain behind them (surface
// style, rendering, colour) — were silently dropped. Nothing references a
// styled item, so the output has no dangling refs and no warning fires; the
// geometry just loses its render style. The relations pass must run before
// dependency resolution so resolveStyles covers relation-discovered geometry.
test("extract keeps the styled items of every included geometry item", async () => {
  const splitter = new IfcSplitterNode();
  const inputPath = path.resolve(assetDir, "resources/ifc/school_str.ifc");
  const outputPath = path.resolve(__dirname, ".tmp", "styled.ifc");

  const extractedIds = await splitter.extract(inputPath, [501], outputPath);

  const source = await readFile(inputPath, "utf8");

  // Every styled item in the source whose target geometry was extracted must
  // be extracted too, along with the styles it binds.
  const missingStyledItems: number[] = [];
  const missingStyles: number[] = [];
  for (const m of source.matchAll(/^#(\d+)\s*=\s*IFCSTYLEDITEM\((.*)$/gm)) {
    const styledItemId = Number(m[1]);
    const [target, ...styleRefs] = [...m[2].matchAll(/#(\d+)/g)].map((r) =>
      Number(r[1]),
    );
    if (!extractedIds.has(target)) continue;
    if (!extractedIds.has(styledItemId)) {
      missingStyledItems.push(styledItemId);
      continue;
    }
    for (const styleId of styleRefs) {
      if (!extractedIds.has(styleId)) missingStyles.push(styleId);
    }
  }

  expect(missingStyledItems, "styled items of included geometry").toHaveLength(
    0,
  );
  expect(missingStyles, "styles bound by included styled items").toHaveLength(
    0,
  );
});

test("extract ifc", async () => {
  const splitter = new IfcSplitterNode();
  const inputPath = path.resolve(assetDir, "resources/ifc/school_str.ifc");
  const outputPath = path.resolve(__dirname, ".tmp", "extracted.ifc");
  const onProgress = vi.fn<(event: IfcSplitterProgressEvent) => unknown>();
  const onSplitsResolved = vi.fn<(event: IfcSplitterGroupsEvent) => unknown>();
  const onExtractWarning = vi.fn<(event: IfcSplitterWarningEvent) => unknown>();
  splitter.onProgress.add(onProgress);
  splitter.onSplitsResolved.add(onSplitsResolved);
  splitter.onExtractWarning.add(onExtractWarning);

  const idsToExtract = [501];
  const extractedIds = await splitter.extract(
    inputPath,
    idsToExtract,
    outputPath,
  );

  expect(onProgress.mock.calls.map(([{ stage }]) => stage)).toEqual([
    "parse",
    "spatial",
    "void-fill",
    "style-maps",
    "classify",
    "aggregate",
    "cluster",
    "relations",
    "resolve",
    "write",
  ]);

  expect(onSplitsResolved).not.toHaveBeenCalled();
  expect(onExtractWarning).not.toHaveBeenCalled();

  // 14576 before: objects listed next to #501 in a relationship (other types,
  // reinforcing bars sharing a material association) were copied in as plain
  // dependencies, unreferenced, together with their geometry.
  // With the column's colour map (IfcIndexedColourMap) and layer assignment,
  // which hang backwards on its geometry.
  expect(extractedIds.size).toBe(94);

  expect(idsToExtract.every((id) => extractedIds.has(id))).toBeTruthy();

  const importer = new IfcImporter();
  importer.addAllAttributes();
  importer.addAllRelations();
  importer.wasm = { path: webIfcDir + path.sep, absolute: true };
  importer.webIfcSettings.COORDINATE_TO_ORIGIN = false;
  const fixtureFrag = await importer.process({
    bytes: await readFile(inputPath),
  });
  const fixtureModel = new SingleThreadedFragmentsModel("fixture", fixtureFrag);
  const extractedFrag = await importer.process({
    bytes: await readFile(outputPath),
  });
  const extractedModel = new SingleThreadedFragmentsModel(
    "extracted",
    extractedFrag,
  );
  // Absolute sampleId/representationId values depend on the importer's
  // dedup internals (the #238 hash change shifted them all), so pin the
  // shape only; the cross-model comparisons below carry the equivalence.
  expect(extractedModel.getItemsGeometry(idsToExtract)).toEqual([
    [
      expect.objectContaining({
        localId: 501,
        sampleId: expect.any(Number),
        representationId: expect.any(Number),
      }),
    ],
  ]);
  expect(fixtureModel.getItemsGeometry(idsToExtract)).toEqual([
    [
      expect.objectContaining({
        localId: 501,
        sampleId: expect.any(Number),
        representationId: expect.any(Number),
      }),
    ],
  ]);
  const comparisons = await Promise.all(
    [
      {
        message: "getGuidsByLocalIds",
        action: (model: SingleThreadedFragmentsModel) =>
          model.getGuidsByLocalIds(idsToExtract),
      },
      {
        message: "getItemsData",
        action: (model: SingleThreadedFragmentsModel) =>
          model.getItemsData(idsToExtract),
      },
      {
        message: "getItemsChildren",
        action: (model: SingleThreadedFragmentsModel) =>
          model.getItemsChildren(idsToExtract),
      },
      {
        message: "getMaterials",
        action: (model: SingleThreadedFragmentsModel) =>
          model.getMaterials(idsToExtract),
      },
      {
        message: "getRelations",
        action: (model: SingleThreadedFragmentsModel) =>
          model.getRelations(idsToExtract),
      },
      {
        message: "getSamples",
        action: async (model: SingleThreadedFragmentsModel) =>
          [...(await model.getSamples(idsToExtract))].map(
            ([, { item, localTransform, material }]) => ({
              item,
              localTransform,
              material,
            }),
          ),
      },
    ].map(async ({ message, action }) => ({
      message,
      actual: await action(extractedModel),
      expected: await action(fixtureModel),
    })),
  );

  comparisons.map(({ message, actual, expected }) =>
    expect.soft(actual, message).toEqual(expected),
  );
}, 60_000);
