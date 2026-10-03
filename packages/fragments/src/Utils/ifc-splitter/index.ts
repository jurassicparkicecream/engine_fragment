/* eslint-disable max-classes-per-file */
/* eslint-disable no-use-before-define */
/* eslint-disable no-cond-assign */

import { Event } from "../event";
import {
  extractArgsString,
  extractLineMeta,
  extractRefs,
  parseHashRef,
  splitIfcArgs,
} from "../ifc-parsing-utils";
import { streamAsyncIterator } from "../ifc-stream";

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface IfcSplitterConfig {
  /**
   * @default {@link ELEMENT_TYPES}
   */
  elementTypes?: string[];
  /**
   * @default {@link SPATIAL_TYPES}
   */
  spatialTypes?: string[];
  /**
   * @see {@link listIdxByType}
   * @returns the index of the argument to parse as a ref list
   */
  listArgIndex?: (ifcType: string) => number | undefined;
}

interface IfcSplitterResolvedConfig {
  /**
   * @see {@link IfcSplitterConfig.elementTypes}
   */
  elementTypes: Set<string>;
  /**
   * @see {@link IfcSplitterConfig.spatialTypes}
   */
  spatialTypes: Set<string>;
  /**
   * @see {@link IfcSplitterConfig.listArgIndex}
   */
  listArgIndex: (ifcType: string) => number | undefined;
}

export interface IfcSplitterIO {
  /**
   * @param path
   * @throws if {@link path} doesn't exist
   * @returns a {@link ReadableStream} streaming ifc lines
   */
  readableStream(path: string): Promise<ReadableStream<string>>;

  /**
   * @param path
   * @returns a {@link WritableStream} able to write ifc lines
   */
  writableStream(path: string): Promise<WritableStream<string>>;
}

export type IfcSplitterStage =
  | "parse"
  | "spatial"
  | "void-fill"
  | "style-maps"
  | "classify"
  | "aggregate"
  | "cluster"
  | "distribute"
  | "relations"
  | "resolve"
  | "build-index"
  | "write";

export interface IfcSplitterProgressEvent {
  stage: IfcSplitterStage;
  timeElapsed: number;
}

export interface IfcSplitterWarningEvent {
  message: string;
  context: { id: number; type?: string };
}

/** Mapping of void/fill relationships between walls, openings, and fillers (doors/windows). */
export interface VoidFillMap {
  wallToOpenings: Map<number, Set<number>>;
  openingToWall: Map<number, number>;
  openingToFillers: Map<number, Set<number>>;
  fillerToOpening: Map<number, number>;
  relLineIds: Map<number, Set<number>>;
}

/** Parent-child relationships between building elements that must stay together (e.g. roof to slabs, element to its ports). */
export interface AggregateMap {
  parentToChildren: Map<number, Set<number>>;
  childToParent: Map<number, number>;
  aggregateRelIds: Map<number, Set<number>>;
}

/** Reverse indices for IFCSTYLEDITEM and IFCMATERIALDEFINITIONREPRESENTATION backward pointers. */
export interface StyleMaps {
  geomToStyledItems: Map<number, number[]>;
  materialToDefReps: Map<number, number[]>;
}

/** Per-group output data: the set of IFC entity IDs to include and any rewritten relationship lines. */
export interface GroupData {
  /**
   * The `groupId` this data was resolved for — the value passed to `split`'s
   * `outputPath` callback. Carried explicitly rather than implied by position,
   * because groups that end up with no elements produce no entry at all.
   */
  groupId: number;
  fileIds: IdSet;
  rewrittenLines: Map<number, string>;
  elementCount: number;
  totalIds: number;
  filePath: string;
}

export interface IfcSplitterGroupsEvent {
  /**
   * One entry per **non-empty** group, ascending by {@link GroupData.groupId}.
   * A `split` into more groups than there are element clusters simply yields
   * fewer entries than `numGroups` — use `groupId` to correlate, not the index.
   */
  data: GroupData[];
}

/** One element at the end of a relationship that spans output files. */
export interface IfcSplitterRelationEnd {
  /** Index of the relationship's attribute that references the element. */
  attribute: number;
  /** Position within that attribute when it is a list, otherwise absent. */
  position?: number;
  /** GlobalId of the element: stable across the source and every part. */
  guid: string;
  /** Express id of the element in the source (and in its part). */
  expressId: number;
  type: string;
  /**
   * {@link GroupData.groupId} of the file that holds the element, or `null`
   * if no output file does (`extract`: the element was not extracted).
   */
  groupId: number | null;
}

/**
 * A relationship whose elements ended up in different output files. It is
 * left out of every file in which it would reference a missing element, so
 * each file stays valid, and is reported here instead so that a consumer can
 * restore it after loading the parts.
 */
export interface IfcSplitterCrossPartRelation {
  type: string;
  /** GlobalId of the relationship. */
  guid: string;
  /** Express id of the relationship in the source. */
  expressId: number;
  /** The relationship's attributes as written in the source (`#id` refers to the source). */
  attributes: string[];
  ends: IfcSplitterRelationEnd[];
}

export interface IfcSplitterCrossPartEvent {
  relations: IfcSplitterCrossPartRelation[];
}

// ---------------------------------------------------------------------------
// Internal interfaces
// ---------------------------------------------------------------------------

interface ParseResult {
  header: string[];
  footer: string[];
  index: LineIndex;
}

interface RelEntry {
  id: number;
  type: string;
  args: string[];
  listIdx: number;
  listRefs: number[];
  idPrefix: string;
}

// ---------------------------------------------------------------------------
// IFC element categories we consider "splittable building elements"
// ---------------------------------------------------------------------------

/**
 * The default {@link IfcSplitterConfig.elementTypes}.
 * Exported so it can be extended rather than replaced.
 *
 * Every subtype of IfcElement in IFC2X3, IFC4 and IFC4X3, plus three
 * products that are not IfcElements but carry their own geometry or belong to
 * one: IFCSPACE, IFCDISTRIBUTIONPORT and IFCPROXY. Anything not listed here is
 * neither split nor copied into any output file, so a missing type silently
 * drops all of its instances. The test suite checks this list against the
 * schema tables of web-ifc.
 */
export const ELEMENT_TYPES = Object.freeze([
  "IFCWALL",
  "IFCWALLSTANDARDCASE",
  "IFCWALLELEMENTEDCASE",
  "IFCSLAB",
  "IFCSLABSTANDARDCASE",
  "IFCSLABELEMENTEDCASE",
  "IFCBEAM",
  "IFCBEAMSTANDARDCASE",
  "IFCCOLUMN",
  "IFCCOLUMNSTANDARDCASE",
  "IFCDOOR",
  "IFCDOORSTANDARDCASE",
  "IFCWINDOW",
  "IFCWINDOWSTANDARDCASE",
  "IFCROOF",
  "IFCSTAIR",
  "IFCSTAIRFLIGHT",
  "IFCRAMP",
  "IFCRAMPFLIGHT",
  "IFCCURTAINWALL",
  "IFCCOVERING",
  "IFCRAILING",
  "IFCPLATE",
  "IFCPLATESTANDARDCASE",
  "IFCMEMBER",
  "IFCMEMBERSTANDARDCASE",
  "IFCFOOTING",
  "IFCPILE",
  "IFCFURNISHINGELEMENT",
  "IFCSANITARYTERMINAL",
  "IFCFLOWSEGMENT",
  "IFCFLOWTERMINAL",
  "IFCFLOWCONTROLLER",
  "IFCFLOWFITTING",
  "IFCFLOWMOVINGDEVICE",
  "IFCFLOWSTORAGEDEVICE",
  "IFCFLOWTREATMENTDEVICE",
  "IFCENERGYCONVERSIONDEVICE",
  "IFCDISTRIBUTIONFLOWELEMENT",
  "IFCDISTRIBUTIONCONTROLELEMENT",
  "IFCDISTRIBUTIONELEMENT",
  "IFCDISTRIBUTIONPORT",
  "IFCBUILDINGELEMENTPROXY",
  "IFCBUILDINGELEMENTPART",
  "IFCOPENINGELEMENT",
  "IFCSPACE",
  "IFCTRANSPORTELEMENT",
  "IFCVIRTUALELEMENT",
  "IFCSHADINGDEVICE",
  "IFCCHIMNEY",
  "IFCGEOGRAPHICELEMENT",
  "IFCPROXY",
  "IFCMECHANICALFASTENER",
  // The remaining IfcElement subtypes of IFC2X3, IFC4 and IFC4X3
  "IFCACTUATOR",
  "IFCAIRTERMINAL",
  "IFCAIRTERMINALBOX",
  "IFCAIRTOAIRHEATRECOVERY",
  "IFCALARM",
  "IFCAUDIOVISUALAPPLIANCE",
  "IFCBEARING",
  "IFCBOILER",
  "IFCBOREHOLE",
  "IFCBUILDINGELEMENT",
  "IFCBUILDINGELEMENTCOMPONENT",
  "IFCBUILTELEMENT",
  "IFCBURNER",
  "IFCCABLECARRIERFITTING",
  "IFCCABLECARRIERSEGMENT",
  "IFCCABLEFITTING",
  "IFCCABLESEGMENT",
  "IFCCAISSONFOUNDATION",
  "IFCCHAMFEREDGEFEATURE",
  "IFCCHILLER",
  "IFCCIVILELEMENT",
  "IFCCOIL",
  "IFCCOMMUNICATIONSAPPLIANCE",
  "IFCCOMPRESSOR",
  "IFCCONDENSER",
  "IFCCONTROLLER",
  "IFCCONVEYORSEGMENT",
  "IFCCOOLEDBEAM",
  "IFCCOOLINGTOWER",
  "IFCCOURSE",
  "IFCDAMPER",
  "IFCDEEPFOUNDATION",
  "IFCDISCRETEACCESSORY",
  "IFCDISTRIBUTIONBOARD",
  "IFCDISTRIBUTIONCHAMBERELEMENT",
  "IFCDUCTFITTING",
  "IFCDUCTSEGMENT",
  "IFCDUCTSILENCER",
  "IFCEARTHWORKSCUT",
  "IFCEARTHWORKSELEMENT",
  "IFCEARTHWORKSFILL",
  "IFCEDGEFEATURE",
  "IFCELECTRICALELEMENT",
  "IFCELECTRICAPPLIANCE",
  "IFCELECTRICDISTRIBUTIONBOARD",
  "IFCELECTRICDISTRIBUTIONPOINT",
  "IFCELECTRICFLOWSTORAGEDEVICE",
  "IFCELECTRICFLOWTREATMENTDEVICE",
  "IFCELECTRICGENERATOR",
  "IFCELECTRICMOTOR",
  "IFCELECTRICTIMECONTROL",
  "IFCELEMENTASSEMBLY",
  "IFCELEMENTCOMPONENT",
  "IFCENGINE",
  "IFCEQUIPMENTELEMENT",
  "IFCEVAPORATIVECOOLER",
  "IFCEVAPORATOR",
  "IFCFAN",
  "IFCFASTENER",
  "IFCFEATUREELEMENT",
  "IFCFEATUREELEMENTADDITION",
  "IFCFEATUREELEMENTSUBTRACTION",
  "IFCFILTER",
  "IFCFIRESUPPRESSIONTERMINAL",
  "IFCFLOWINSTRUMENT",
  "IFCFLOWMETER",
  "IFCFURNITURE",
  "IFCGEOMODEL",
  "IFCGEOSLICE",
  "IFCGEOTECHNICALASSEMBLY",
  "IFCGEOTECHNICALELEMENT",
  "IFCGEOTECHNICALSTRATUM",
  "IFCHEATEXCHANGER",
  "IFCHUMIDIFIER",
  "IFCIMPACTPROTECTIONDEVICE",
  "IFCINTERCEPTOR",
  "IFCJUNCTIONBOX",
  "IFCKERB",
  "IFCLAMP",
  "IFCLIGHTFIXTURE",
  "IFCLIQUIDTERMINAL",
  "IFCMEDICALDEVICE",
  "IFCMOBILETELECOMMUNICATIONSAPPLIANCE",
  "IFCMOORINGDEVICE",
  "IFCMOTORCONNECTION",
  "IFCNAVIGATIONELEMENT",
  "IFCOPENINGSTANDARDCASE",
  "IFCOUTLET",
  "IFCPAVEMENT",
  "IFCPIPEFITTING",
  "IFCPIPESEGMENT",
  "IFCPROJECTIONELEMENT",
  "IFCPROTECTIVEDEVICE",
  "IFCPROTECTIVEDEVICETRIPPINGUNIT",
  "IFCPUMP",
  "IFCRAIL",
  "IFCREINFORCEDSOIL",
  "IFCREINFORCINGBAR",
  "IFCREINFORCINGELEMENT",
  "IFCREINFORCINGMESH",
  "IFCROUNDEDEDGEFEATURE",
  "IFCSENSOR",
  "IFCSIGN",
  "IFCSIGNAL",
  "IFCSOLARDEVICE",
  "IFCSPACEHEATER",
  "IFCSTACKTERMINAL",
  "IFCSURFACEFEATURE",
  "IFCSWITCHINGDEVICE",
  "IFCSYSTEMFURNITUREELEMENT",
  "IFCTANK",
  "IFCTENDON",
  "IFCTENDONANCHOR",
  "IFCTENDONCONDUIT",
  "IFCTRACKELEMENT",
  "IFCTRANSFORMER",
  "IFCTRANSPORTATIONDEVICE",
  "IFCTUBEBUNDLE",
  "IFCUNITARYCONTROLELEMENT",
  "IFCUNITARYEQUIPMENT",
  "IFCVALVE",
  "IFCVEHICLE",
  "IFCVIBRATIONDAMPER",
  "IFCVIBRATIONISOLATOR",
  "IFCVOIDINGFEATURE",
  "IFCWASTETERMINAL",
] as const);

/**
 * The default {@link IfcSplitterConfig.spatialTypes}.
 * Exported so it can be extended rather than replaced.
 */
export const SPATIAL_TYPES = Object.freeze([
  "IFCPROJECT",
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
] as const);

/**
 * Returns the argument index at which a given IFC type stores its list of
 * "related objects". Getting this wrong causes the rewriter to read the wrong
 * field, end up with an empty list, and skip the line entirely — dropping all
 * its transitive dependencies (property sets, materials, styles, etc.) from
 * the split output.
 *
 * The default {@link IfcSplitterConfig.listArgIndex}. Exported so an override
 * can delegate to it for the types it doesn't care about.
 */
export const listIdxByType = (type: string): number => {
  switch (type) {
    case "IFCRELAGGREGATES":
    case "IFCRELNESTS":
    case "IFCRELCOVERSBLDGELEMENTS":
    case "IFCRELCOVERSSPACES":
    case "IFCRELPOSITIONS":
    case "IFCRELADHERESTOELEMENT":
      return 5;
    case "IFCRELCONNECTSELEMENTS":
    case "IFCRELCONNECTSPATHELEMENTS":
      // argument 4 is ConnectionGeometry; RelatingElement is 5
      return 5;
    case "IFCRELCONNECTSWITHREALIZINGELEMENTS":
      return 7;
    case "IFCPRESENTATIONLAYERASSIGNMENT":
      return 2;
    default:
      return 4;
  }
};

/**
 * Whether the splitter should rewrite a line of this type per-group. Covers
 * all IFCREL* types (except void/fill, which are handled separately) plus a
 * few non-REL types that still reference lists of elements.
 */
const shouldRewriteType = (type: string): boolean => {
  if (type === "IFCRELVOIDSELEMENT") return false;
  if (type === "IFCRELFILLSELEMENT") return false;
  if (type.startsWith("IFCREL")) return true;
  return false;
};

type IfcSchemaFamily = "IFC2X3" | "IFC4" | "IFC4X3";

const schemaFamily = (header: string[]): IfcSchemaFamily => {
  const schema = header.find((line) => /FILE_SCHEMA/i.test(line)) ?? "";
  if (/IFC2X3/i.test(schema)) return "IFC2X3";
  if (/IFC4X3/i.test(schema)) return "IFC4X3";
  return "IFC4";
};

/**
 * Entity types that nothing references: they attach themselves to their target
 * (the INVERSE side in the schema), so collecting forward references never
 * reaches them. Per type, the attributes (STEP index) that point to the
 * target. Generated from the EXPRESS schemas IFC2X3 TC1, IFC4 ADD2 TC1 and
 * IFC4X3 ADD2: every non-abstract entity no explicit attribute can refer to,
 * with the attribute named in the INVERSE clause that targets it, plus
 * IfcShapeAspect, unused geometric subcontexts and the material/profile
 * property sets. IfcRel* types,
 * IfcStyledItem and IfcMaterialDefinitionRepresentation are handled elsewhere.
 */
const BACKWARD_ATTACHMENTS: Readonly<
  Record<IfcSchemaFamily, Readonly<Record<string, readonly number[]>>>
> = {
  IFC2X3: {
    IFCAPPLIEDVALUERELATIONSHIP: [0, 1],
    IFCAPPROVALACTORRELATIONSHIP: [1],
    IFCAPPROVALPROPERTYRELATIONSHIP: [0],
    IFCAPPROVALRELATIONSHIP: [0, 1],
    IFCCLASSIFICATIONITEMRELATIONSHIP: [0, 1],
    IFCCONSTRAINTAGGREGATIONRELATIONSHIP: [2, 3],
    IFCCONSTRAINTCLASSIFICATIONRELATIONSHIP: [0],
    IFCCONSTRAINTRELATIONSHIP: [2, 3],
    IFCCURRENCYRELATIONSHIP: [0, 1],
    IFCDIMENSIONCALLOUTRELATIONSHIP: [2, 3],
    IFCDIMENSIONPAIR: [2, 3],
    IFCDOCUMENTINFORMATIONRELATIONSHIP: [0, 1],
    IFCDRAUGHTINGCALLOUTRELATIONSHIP: [2, 3],
    IFCEXTENDEDMATERIALPROPERTIES: [0],
    IFCFUELPROPERTIES: [0],
    IFCGENERALMATERIALPROPERTIES: [0],
    IFCGEOMETRICREPRESENTATIONSUBCONTEXT: [6],
    IFCHYGROSCOPICMATERIALPROPERTIES: [0],
    IFCMATERIALCLASSIFICATIONRELATIONSHIP: [1],
    IFCMECHANICALCONCRETEMATERIALPROPERTIES: [0],
    IFCMECHANICALMATERIALPROPERTIES: [0],
    IFCMECHANICALSTEELMATERIALPROPERTIES: [0],
    IFCOPTICALMATERIALPROPERTIES: [0],
    IFCORGANIZATIONRELATIONSHIP: [2, 3],
    IFCPRESENTATIONLAYERASSIGNMENT: [2],
    IFCPRESENTATIONLAYERWITHSTYLE: [2],
    IFCPRODUCTSOFCOMBUSTIONPROPERTIES: [0],
    IFCPROPERTYCONSTRAINTRELATIONSHIP: [0],
    IFCPROPERTYDEPENDENCYRELATIONSHIP: [0, 1],
    IFCREFERENCESVALUEDOCUMENT: [1],
    IFCSHAPEASPECT: [0, 4],
    IFCTHERMALMATERIALPROPERTIES: [0],
    IFCTIMESERIESREFERENCERELATIONSHIP: [0],
    IFCWATERPROPERTIES: [0],
  },
  IFC4: {
    IFCAPPROVALRELATIONSHIP: [2, 3],
    IFCDOCUMENTINFORMATIONRELATIONSHIP: [2, 3],
    IFCEXTERNALREFERENCERELATIONSHIP: [2, 3],
    IFCGEOMETRICREPRESENTATIONSUBCONTEXT: [6],
    IFCINDEXEDCOLOURMAP: [0],
    IFCINDEXEDTRIANGLETEXTUREMAP: [0, 1],
    IFCMAPCONVERSION: [0],
    IFCMATERIALPROPERTIES: [3],
    IFCMATERIALRELATIONSHIP: [2, 3],
    IFCORGANIZATIONRELATIONSHIP: [2, 3],
    IFCPRESENTATIONLAYERASSIGNMENT: [2],
    IFCPRESENTATIONLAYERWITHSTYLE: [2],
    IFCPROFILEPROPERTIES: [3],
    IFCPROPERTYDEPENDENCYRELATIONSHIP: [2, 3],
    IFCRESOURCEAPPROVALRELATIONSHIP: [2, 3],
    IFCRESOURCECONSTRAINTRELATIONSHIP: [2, 3],
    IFCSHAPEASPECT: [0, 4],
    IFCTEXTURECOORDINATEGENERATOR: [0],
    IFCTEXTUREMAP: [0, 2],
  },
  IFC4X3: {
    IFCAPPROVALRELATIONSHIP: [2, 3],
    IFCDOCUMENTINFORMATIONRELATIONSHIP: [2, 3],
    IFCEXTERNALREFERENCERELATIONSHIP: [2, 3],
    IFCGEOMETRICREPRESENTATIONSUBCONTEXT: [6],
    IFCINDEXEDCOLOURMAP: [0],
    IFCINDEXEDPOLYGONALTEXTUREMAP: [0, 1, 3],
    IFCINDEXEDTRIANGLETEXTUREMAP: [0, 1],
    IFCMAPCONVERSION: [0],
    IFCMAPCONVERSIONSCALED: [0],
    IFCMATERIALPROPERTIES: [3],
    IFCMATERIALRELATIONSHIP: [2, 3],
    IFCORGANIZATIONRELATIONSHIP: [2, 3],
    IFCPRESENTATIONLAYERASSIGNMENT: [2],
    IFCPRESENTATIONLAYERWITHSTYLE: [2],
    IFCPROFILEPROPERTIES: [3],
    IFCPROPERTYDEPENDENCYRELATIONSHIP: [2, 3],
    IFCRESOURCEAPPROVALRELATIONSHIP: [2, 3],
    IFCRESOURCECONSTRAINTRELATIONSHIP: [2, 3],
    IFCRIGIDOPERATION: [0],
    IFCSHAPEASPECT: [0, 4],
    IFCTEXTURECOORDINATEGENERATOR: [0],
    IFCTEXTUREMAP: [0, 2],
    IFCWELLKNOWNTEXT: [1],
  },
};

const BACKWARD_TYPES = new Set(
  Object.values(BACKWARD_ATTACHMENTS).flatMap((types) => Object.keys(types)),
);

interface BackwardEntry {
  id: number;
  type: string;
  args: string[];
  attach: readonly number[];
  idPrefix: string;
}

function backwardEntries(
  index: LineIndex,
  family: IfcSchemaFamily,
): BackwardEntry[] {
  const table = BACKWARD_ATTACHMENTS[family];
  const entries: BackwardEntry[] = [];
  for (let id = 0; id <= index.maxId; id++) {
    const type = index.getType(id);
    const attach = type && table[type];
    if (!attach) continue;
    const raw = index.getRaw(id);
    const argsStr = extractArgsString(raw);
    const idMatch = raw?.match(/^(#\d+\s*=\s*)/);
    if (!argsStr || !idMatch) continue;
    entries.push({
      id,
      type: type!,
      args: splitIfcArgs(argsStr),
      attach,
      idPrefix: idMatch[1],
    });
  }
  return entries;
}

/**
 * Adds every backward-attached entity whose target is in `fileIds`, with its
 * dependencies, until nothing changes (an attached entity can be the target
 * of another, e.g. a texture map and its coordinates). A list attribute is
 * narrowed to the targets in the file (a layer assignment lists the
 * representations of every element on that layer).
 */
function attachBackward(
  entries: BackwardEntry[],
  fileIds: IdSet,
  index: LineIndex,
  allElementIds: Set<number>,
  rewrittenLines: Map<number, string>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (fileIds.has(entry.id)) continue;
      let attached = false;
      let newArgs: string[] | null = null;
      const dropped = new Set<number>();
      for (const i of entry.attach) {
        const arg = entry.args[i];
        if (arg === undefined) continue;
        const refs = extractRefs(arg);
        const present = refs.filter((r) => fileIds.has(r));
        if (present.length === 0) continue;
        attached = true;
        if (present.length < refs.length && arg.trimStart().startsWith("(")) {
          for (const r of refs) if (!fileIds.has(r)) dropped.add(r);
          newArgs ??= [...entry.args];
          newArgs[i] = rewriteListArg(arg, present);
        }
      }
      if (!attached) continue;
      if (newArgs) {
        rewrittenLines.set(
          entry.id,
          `${entry.idPrefix}${entry.type}(${newArgs.join(",")});`,
        );
      }
      fileIds.add(entry.id);
      const refs = index.getRefs(entry.id);
      if (refs) {
        for (const r of refs) {
          if (dropped.has(r) || allElementIds.has(r)) continue;
          collectDeps(r, index, fileIds, allElementIds);
        }
      }
      changed = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Compact line storage: sparse arrays indexed by IFC id
// ---------------------------------------------------------------------------
class LineIndex {
  types: (string | undefined)[] = [];
  maxId: number = 0;
  private _typeIntern: Map<string, string> = new Map();
  specialRaws: Map<number, string> = new Map();
  /** GlobalIds of the lines the parser was asked to remember (elements). */
  guids: Map<number, string> = new Map();

  private _refBuf: Int32Array = new Int32Array(4 * 1024 * 1024);
  private _refBufUsed: number = 0;
  private _refStart: (number | undefined)[] = [];
  private _refLen: (number | undefined)[] = [];

  set(id: number, type: string, refs: number[], raw: string): void {
    let t = this._typeIntern.get(type);
    if (!t) {
      t = type;
      this._typeIntern.set(type, t);
    }
    this.types[id] = t;
    if (id > this.maxId) this.maxId = id;

    const start = this._refBufUsed;
    const needed = start + refs.length;
    if (needed > this._refBuf.length) {
      const newSize = Math.max(this._refBuf.length * 2, needed);
      const newBuf = new Int32Array(newSize);
      newBuf.set(this._refBuf);
      this._refBuf = newBuf;
    }
    for (let i = 0; i < refs.length; i++) {
      this._refBuf[start + i] = refs[i];
    }
    this._refBufUsed = start + refs.length;
    this._refStart[id] = start;
    this._refLen[id] = refs.length;

    if (
      BACKWARD_TYPES.has(t) ||
      t.startsWith("IFCREL") ||
      t === "IFCSTYLEDITEM" ||
      t === "IFCMATERIALDEFINITIONREPRESENTATION"
    ) {
      this.specialRaws.set(id, raw);
    }
  }

  finalize(): void {
    this._refBuf = this._refBuf.slice(0, this._refBufUsed);
  }

  has(id: number): boolean {
    return this.types[id] !== undefined;
  }

  getType(id: number): string | undefined {
    return this.types[id];
  }

  getRefs(id: number): Int32Array | null {
    const len = this._refLen[id];
    if (len === undefined) return null;
    const start = this._refStart[id];
    if (start === undefined) return null;
    return this._refBuf.subarray(start, start + len);
  }

  getRaw(id: number): string | undefined {
    return this.specialRaws.get(id);
  }

  getAll(types: Set<string>) {
    const allElementIds = new Set<number>();
    for (let id = 0; id <= this.maxId; id++) {
      const type = this.getType(id);
      if (type && types.has(type)) allElementIds.add(id);
    }
    return allElementIds;
  }

  free(): void {
    // Deliberately null-out fields to reclaim memory before the write pass
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (this as any).types = null;
    (this as any)._refBuf = null;
    (this as any)._refStart = null;
    (this as any)._refLen = null;
    (this as any).specialRaws = null;
    (this as any).guids = null;
  }
}

// ---------------------------------------------------------------------------
// Set of IFC ids backed by a bitmap over 0..maxId
// ---------------------------------------------------------------------------

/**
 * A set of IFC ids stored as one bit per possible id. A group of a large file
 * easily holds more ids than a JavaScript `Set` can (2^24 in V8), and the
 * bitmap is also far smaller: 3.6 MB for 28 million ids.
 */
export class IdSet implements Iterable<number> {
  private readonly bits: Uint32Array;
  private count = 0;

  /** @param maxId - the largest id this set will ever hold */
  constructor(readonly maxId: number) {
    this.bits = new Uint32Array((maxId >>> 5) + 1);
  }

  get size(): number {
    return this.count;
  }

  has(id: number): boolean {
    if (id < 0 || id > this.maxId) return false;
    return (this.bits[id >>> 5] & (1 << (id & 31))) !== 0;
  }

  /** Ids outside 0..maxId are ignored: no line defines them. */
  add(id: number): this {
    if (id < 0 || id > this.maxId) return this;
    const word = id >>> 5;
    const bit = 1 << (id & 31);
    if ((this.bits[word] & bit) === 0) {
      this.bits[word] |= bit;
      this.count++;
    }
    return this;
  }

  clone(): IdSet {
    const copy = new IdSet(this.maxId);
    copy.bits.set(this.bits);
    copy.count = this.count;
    return copy;
  }

  *[Symbol.iterator](): IterableIterator<number> {
    for (let word = 0; word < this.bits.length; word++) {
      let value = this.bits[word];
      while (value !== 0) {
        const low = value & -value;
        yield (word << 5) + (31 - Math.clz32(low));
        value ^= low;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Collect all ids referenced by a given id, recursively.
// Stops at element boundaries to avoid pulling in other groups' elements.
// ---------------------------------------------------------------------------
function collectDeps(
  startId: number,
  index: LineIndex,
  visited: IdSet,
  allElementIds: Set<number>,
): void {
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    const refs = index.getRefs(id);
    // No refs entry means no line defines this id: it was only ever REFERENCED,
    // by a dangling `#N` or by a `#` inside a quoted string. Nothing is written
    // for it, so it must not enter `visited` — that set is the group's id list,
    // reported to the caller and used to size id-indexed maps.
    if (!refs) continue;
    visited.add(id);
    for (let i = 0; i < refs.length; i++) {
      const refId = refs[i];
      if (visited.has(refId)) continue;
      if (allElementIds.has(refId)) continue;
      stack.push(refId);
    }
  }
}

function collectDepsAll(
  startId: number,
  index: LineIndex,
  visited: IdSet,
): void {
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    const refs = index.getRefs(id);
    // Undefined id — see collectDeps.
    if (!refs) continue;
    visited.add(id);
    for (let i = 0; i < refs.length; i++) {
      if (!visited.has(refs[i])) stack.push(refs[i]);
    }
  }
}

// ---------------------------------------------------------------------------
// Build void/fill coupling map
// ---------------------------------------------------------------------------
function buildVoidFillMap(index: LineIndex): VoidFillMap {
  const wallToOpenings = new Map<number, Set<number>>();
  const openingToWall = new Map<number, number>();
  const openingToFillers = new Map<number, Set<number>>();
  const fillerToOpening = new Map<number, number>();
  const relLineIds = new Map<number, Set<number>>();

  for (let id = 0; id <= index.maxId; id++) {
    const type = index.getType(id);
    if (!type) continue;

    if (type === "IFCRELVOIDSELEMENT") {
      const raw = index.getRaw(id);
      const argsStr = extractArgsString(raw);
      if (argsStr) {
        const args = splitIfcArgs(argsStr);
        if (args.length >= 6) {
          const wallId = parseHashRef(args[4]);
          const openingId = parseHashRef(args[5]);
          if (wallId && openingId) {
            if (!wallToOpenings.has(wallId))
              wallToOpenings.set(wallId, new Set());
            wallToOpenings.get(wallId)!.add(openingId);
            openingToWall.set(openingId, wallId);
            addToSetMap(relLineIds, wallId, id);
            addToSetMap(relLineIds, openingId, id);
          }
        }
      }
    } else if (type === "IFCRELFILLSELEMENT") {
      const raw = index.getRaw(id);
      const argsStr = extractArgsString(raw);
      if (argsStr) {
        const args = splitIfcArgs(argsStr);
        if (args.length >= 6) {
          const openingId = parseHashRef(args[4]);
          const fillerId = parseHashRef(args[5]);
          if (openingId && fillerId) {
            if (!openingToFillers.has(openingId))
              openingToFillers.set(openingId, new Set());
            openingToFillers.get(openingId)!.add(fillerId);
            fillerToOpening.set(fillerId, openingId);
            addToSetMap(relLineIds, openingId, id);
            addToSetMap(relLineIds, fillerId, id);
          }
        }
      }
    }
  }

  return {
    wallToOpenings,
    openingToWall,
    openingToFillers,
    fillerToOpening,
    relLineIds,
  };
}

/**
 * Relationships whose elements must end up in the same output file, as
 * `[parent argument index, child argument index]`. Besides aggregation this
 * keeps ports with the element they belong to (IfcRelNests in IFC4 and later,
 * IfcRelConnectsPortToElement in IFC2X3) and projections or surface features
 * with their host, so neither side is written with a dangling reference.
 * Elements contained in an IfcSpace are coupled separately, and only as far as
 * the groups stay balanced: see {@link coupleSpaceContents}.
 */
const CLUSTER_RELS: ReadonlyMap<string, readonly [number, number]> = new Map([
  ["IFCRELAGGREGATES", [4, 5]],
  ["IFCRELNESTS", [4, 5]],
  ["IFCRELCONNECTSPORTTOELEMENT", [5, 4]],
  ["IFCRELPROJECTSELEMENT", [4, 5]],
  ["IFCRELADHERESTOELEMENT", [4, 5]],
]);

function buildAggregateMap(
  index: LineIndex,
  allElementIds: Set<number>,
): AggregateMap {
  const parentToChildren = new Map<number, Set<number>>();
  const childToParent = new Map<number, number>();
  const aggregateRelIds = new Map<number, Set<number>>();

  for (let id = 0; id <= index.maxId; id++) {
    const type = index.getType(id);
    const argIdx = type && CLUSTER_RELS.get(type);
    if (!argIdx) continue;
    const [parentIdx, childIdx] = argIdx;

    const raw = index.getRaw(id);
    const argsStr = extractArgsString(raw);
    if (!argsStr) continue;
    const args = splitIfcArgs(argsStr);
    if (args.length <= Math.max(parentIdx, childIdx)) continue;

    const parentId = parseHashRef(args[parentIdx]);
    if (!parentId || !allElementIds.has(parentId)) continue;

    const childRefs = extractRefs(args[childIdx]);
    const elementChildren = childRefs.filter((r) => allElementIds.has(r));
    if (elementChildren.length === 0) continue;

    if (!parentToChildren.has(parentId))
      parentToChildren.set(parentId, new Set());
    for (const cid of elementChildren) {
      parentToChildren.get(parentId)!.add(cid);
      childToParent.set(cid, parentId);
      addToSetMap(aggregateRelIds, parentId, id);
      addToSetMap(aggregateRelIds, cid, id);
    }
  }

  return { parentToChildren, childToParent, aggregateRelIds };
}

function traverseSpatialStructure(index: LineIndex, spatialTypes: Set<string>) {
  const spatialIds = new Set<number>();
  for (let id = 0; id <= index.maxId; id++) {
    const type = index.getType(id);
    if (type && spatialTypes.has(type)) spatialIds.add(id);
  }
  const sharedIds = new IdSet(index.maxId);
  for (const sid of spatialIds) {
    collectDepsAll(sid, index, sharedIds);
  }
  for (let id = 0; id <= index.maxId; id++) {
    const type = index.getType(id);
    if (type === "IFCRELAGGREGATES") {
      const raw = index.getRaw(id);
      const argsStr = extractArgsString(raw);
      if (argsStr) {
        const args = splitIfcArgs(argsStr);
        if (args.length >= 6) {
          const relatingId = parseHashRef(args[4]);
          if (relatingId && spatialIds.has(relatingId)) {
            const listRefs = extractRefs(args[5]);
            if (listRefs.every((r) => spatialIds.has(r))) {
              collectDepsAll(id, index, sharedIds);
            }
          }
        }
      }
    }
  }
  return sharedIds;
}

/**
 * The rewritten value of a relationship's element argument, keeping only
 * `refs`. A list stays a list; a single reference (e.g. RelatingPort of
 * IfcRelConnectsPortToElement) is kept as it is, because wrapping it in
 * parentheses would turn it into a list where the schema expects an entity.
 */
function rewriteListArg(original: string, refs: number[]): string {
  if (!original.trimStart().startsWith("(")) return original;
  return `(${refs.map((r) => `#${r}`).join(",")})`;
}

/**
 * Relationships that place an object in the structure. A non-element object
 * listed here (e.g. an IfcSpatialZone, IfcAnnotation or IfcGrid in a storey)
 * is written to exactly one group, see {@link claimStructureMembers}.
 */
const STRUCTURE_RELS = new Set([
  "IFCRELCONTAINEDINSPATIALSTRUCTURE",
  "IFCRELAGGREGATES",
  "IFCRELNESTS",
]);

/**
 * Assigns every object that a structure relationship lists but that is neither
 * an element nor shared to one group: the group of the first element listed
 * next to it, or the first group. Without this such objects were copied as
 * bare dependencies into every group that shared any relationship with them.
 */
function claimStructureMembers(
  relEntries: RelEntry[],
  groupOf: Map<number, number>,
  sharedIds: IdSet,
  allElementIds: Set<number>,
  firstGroup: number,
): Map<number, number> {
  const claimedBy = new Map<number, number>();
  for (const rel of relEntries) {
    if (!STRUCTURE_RELS.has(rel.type)) continue;
    let group: number | undefined;
    for (const r of rel.listRefs) {
      group = groupOf.get(r);
      if (group !== undefined) break;
    }
    for (const r of rel.listRefs) {
      if (allElementIds.has(r) || sharedIds.has(r) || claimedBy.has(r))
        continue;
      claimedBy.set(r, group ?? firstGroup);
    }
  }
  return claimedBy;
}

/**
 * Collects what a rewritten relationship line references, except the list
 * entries it dropped: those belong to other groups (or to none).
 */
function collectRelDeps(
  relId: number,
  listRefs: number[],
  kept: number[],
  index: LineIndex,
  fileIds: IdSet,
  allElementIds: Set<number>,
): void {
  const refs = index.getRefs(relId);
  if (!refs) return;
  const dropped = new Set(listRefs);
  for (const r of kept) dropped.delete(r);
  for (const rid of refs) {
    if (allElementIds.has(rid) || dropped.has(rid)) continue;
    collectDeps(rid, index, fileIds, allElementIds);
  }
}

/**
 * Whether a (rewritten) relationship line would reference an element that is
 * not in the file: any element it references, except the list entries the
 * rewrite dropped, must pass `inFile`.
 */
function crossesFile(
  relId: number,
  listRefs: number[],
  kept: number[],
  index: LineIndex,
  allElementIds: Set<number>,
  inFile: (id: number) => boolean,
): boolean {
  const refs = index.getRefs(relId);
  if (!refs) return false;
  const keptSet = new Set(kept);
  const listSet = new Set(listRefs);
  for (const r of refs) {
    if (!allElementIds.has(r) || inFile(r)) continue;
    if (listSet.has(r) && !keptSet.has(r)) continue;
    return true;
  }
  return false;
}

const guidOfRaw = (raw: string | undefined) =>
  /\(\s*'([^']*)'/.exec(raw ?? "")?.[1] ?? "";

function describeCrossPartRelation(
  relId: number,
  index: LineIndex,
  allElementIds: Set<number>,
  groupOf: (id: number) => number | null,
): IfcSplitterCrossPartRelation {
  const raw = index.getRaw(relId);
  const args = splitIfcArgs(extractArgsString(raw) ?? "");
  const ends: IfcSplitterRelationEnd[] = [];
  args.forEach((arg, attribute) => {
    const isList = arg.trimStart().startsWith("(");
    extractRefs(arg).forEach((expressId, position) => {
      if (!allElementIds.has(expressId)) return;
      ends.push({
        attribute,
        ...(isList ? { position } : {}),
        guid: index.guids.get(expressId) ?? "",
        expressId,
        type: index.getType(expressId) ?? "",
        groupId: groupOf(expressId),
      });
    });
  });
  return {
    type: index.getType(relId) ?? "",
    guid: guidOfRaw(raw),
    expressId: relId,
    attributes: args,
    ends,
  };
}

function addToSetMap(
  map: Map<number, Set<number>>,
  key: number,
  value: number,
): void {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(value);
}

// ---------------------------------------------------------------------------
// Cluster weights and size-limited coupling
// ---------------------------------------------------------------------------

/**
 * Approximate number of lines each cluster adds to a group: its elements and
 * everything they reference, minus the shared spatial structure. Lines already
 * counted for an earlier cluster (types, materials, mapped geometry) are
 * counted again but not traversed again, which keeps this linear in the file.
 */
function clusterWeights(
  clusters: number[][],
  index: LineIndex,
  sharedIds: IdSet,
  allElementIds: Set<number>,
): number[] {
  const seenBy = new Int32Array(index.maxId + 1);
  return clusters.map((cluster, c) => {
    const stamp = c + 1;
    let weight = 0;
    const stack = [...cluster];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seenBy[id] === stamp) continue;
      const refs = index.getRefs(id);
      if (!refs) continue;
      const seenBefore = seenBy[id] !== 0;
      seenBy[id] = stamp;
      if (!sharedIds.has(id)) weight++;
      if (seenBefore) continue;
      for (let i = 0; i < refs.length; i++) {
        if (!allElementIds.has(refs[i])) stack.push(refs[i]);
      }
    }
    return weight;
  });
}

/**
 * Moves elements contained in an IfcSpace (IfcSpace is a split element, unlike
 * a storey) into the cluster of that space, so their containment does not
 * point into another file. Unlike the couplings in {@link CLUSTER_RELS} this
 * one can grow without bound (a single space may contain a whole floor), so a
 * merge is skipped when it would make the cluster heavier than one group's
 * fair share. Skipped elements keep a containment line whose space lives in
 * another file.
 */
function coupleSpaceContents(
  clusters: number[][],
  weights: number[],
  numGroups: number,
  index: LineIndex,
  allElementIds: Set<number>,
): void {
  const total = weights.reduce((sum, w) => sum + w, 0);
  const limit = Math.ceil(total / numGroups);
  const clusterOf = new Map<number, number>();
  clusters.forEach((cluster, c) => {
    for (const eid of cluster) clusterOf.set(eid, c);
  });
  for (let id = 0; id <= index.maxId; id++) {
    if (index.getType(id) !== "IFCRELCONTAINEDINSPATIALSTRUCTURE") continue;
    const argsStr = extractArgsString(index.getRaw(id));
    if (!argsStr) continue;
    const args = splitIfcArgs(argsStr);
    if (args.length < 6) continue;
    const spaceId = parseHashRef(args[5]);
    if (!spaceId || !allElementIds.has(spaceId)) continue;
    for (const child of extractRefs(args[4])) {
      const target = clusterOf.get(spaceId);
      const source = clusterOf.get(child);
      if (target === undefined || source === undefined) continue;
      if (source === target) continue;
      if (weights[target] + weights[source] > limit) continue;
      for (const eid of clusters[source]) {
        clusters[target].push(eid);
        clusterOf.set(eid, target);
      }
      weights[target] += weights[source];
      clusters[source] = [];
      weights[source] = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Cluster elements that must stay together (void/fill + aggregation)
// ---------------------------------------------------------------------------
function getCluster(
  elementId: number,
  vfMap: VoidFillMap,
  aggMap: AggregateMap,
): Set<number> {
  const cluster = new Set([elementId]);
  const queue = [elementId];

  while (queue.length > 0) {
    const eid = queue.shift()!;
    expandVoidFill(eid, vfMap, cluster, queue);
    expandAggregate(eid, aggMap, cluster, queue);
  }

  return cluster;
}

function expandVoidFill(
  eid: number,
  vfMap: VoidFillMap,
  cluster: Set<number>,
  queue: number[],
): void {
  function addIfNew(id: number): void {
    if (!cluster.has(id)) {
      cluster.add(id);
      queue.push(id);
    }
  }

  const openings = vfMap.wallToOpenings.get(eid);
  if (openings) {
    for (const oid of openings) {
      addIfNew(oid);
      const fillers = vfMap.openingToFillers.get(oid);
      if (fillers) for (const fid of fillers) addIfNew(fid);
    }
  }

  const oid2 = vfMap.fillerToOpening.get(eid);
  if (oid2) {
    addIfNew(oid2);
    const wallId = vfMap.openingToWall.get(oid2);
    if (wallId) addIfNew(wallId);
  }

  const wallId2 = vfMap.openingToWall.get(eid);
  if (wallId2) addIfNew(wallId2);
}

function expandAggregate(
  eid: number,
  aggMap: AggregateMap,
  cluster: Set<number>,
  queue: number[],
): void {
  function addIfNew(id: number): void {
    if (!cluster.has(id)) {
      cluster.add(id);
      queue.push(id);
    }
  }

  const children = aggMap.parentToChildren.get(eid);
  if (children) {
    for (const cid of children) addIfNew(cid);
  }

  const parentId = aggMap.childToParent.get(eid);
  if (parentId) {
    addIfNew(parentId);
    const siblings = aggMap.parentToChildren.get(parentId);
    if (siblings) {
      for (const sid of siblings) addIfNew(sid);
    }
  }
}

// ---------------------------------------------------------------------------
// Build reverse style maps
// ---------------------------------------------------------------------------
function buildStyleMaps(index: LineIndex): StyleMaps {
  const geomToStyledItems = new Map<number, number[]>();
  const materialToDefReps = new Map<number, number[]>();

  for (let id = 0; id <= index.maxId; id++) {
    const type = index.getType(id);
    if (!type) continue;

    if (type === "IFCSTYLEDITEM") {
      const raw = index.getRaw(id);
      const argsStr = extractArgsString(raw);
      if (!argsStr) continue;
      const args = splitIfcArgs(argsStr);
      if (args.length >= 1) {
        const geomRef = parseHashRef(args[0]);
        if (geomRef) {
          if (!geomToStyledItems.has(geomRef))
            geomToStyledItems.set(geomRef, []);
          geomToStyledItems.get(geomRef)!.push(id);
        }
      }
    } else if (type === "IFCMATERIALDEFINITIONREPRESENTATION") {
      const raw = index.getRaw(id);
      const argsStr = extractArgsString(raw);
      if (!argsStr) continue;
      const args = splitIfcArgs(argsStr);
      if (args.length >= 4) {
        const matRef = parseHashRef(args[3]);
        if (matRef) {
          if (!materialToDefReps.has(matRef)) materialToDefReps.set(matRef, []);
          materialToDefReps.get(matRef)!.push(id);
        }
      }
    }
  }

  return { geomToStyledItems, materialToDefReps };
}

function resolveStyles(
  fileIds: IdSet,
  index: LineIndex,
  styleMaps: StyleMaps,
  allElementIds: Set<number>,
): void {
  for (const [geomId, styledItemIds] of styleMaps.geomToStyledItems) {
    if (fileIds.has(geomId)) {
      for (const sid of styledItemIds) {
        collectDeps(sid, index, fileIds, allElementIds);
      }
    }
  }
  for (const [matId, defRepIds] of styleMaps.materialToDefReps) {
    if (fileIds.has(matId)) {
      for (const mid of defRepIds) {
        collectDeps(mid, index, fileIds, allElementIds);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main split logic
// ---------------------------------------------------------------------------

/**
 * Maps every parsed IFC id to the groups whose output file must contain it.
 *
 * Laid out CSR-style — `starts` slices into a flat `members` array — rather
 * than as one bit per group in a `Uint32Array`, so the number of groups is not
 * capped at 32. Lookup is a `subarray` view: O(1) and allocation-free, which
 * matters because the write pass calls it once per data line.
 */
class IdGroupIndex {
  private readonly starts: Uint32Array;
  private readonly members: Uint32Array;
  private readonly maxId: number;

  constructor(groupsData: GroupData[], maxId: number) {
    // Pass 1 — count each id's memberships into starts[id + 1], so the prefix
    // sum below leaves starts[id] holding the id's own start offset.
    const starts = new Uint32Array(maxId + 2);
    let total = 0;
    for (const groupData of groupsData) {
      for (const id of groupData.fileIds) {
        if (id < 0 || id > maxId) continue; // dangling ref, no line to emit
        starts[id + 1] += 1;
        total += 1;
      }
    }
    for (let i = 1; i < starts.length; i++) starts[i] += starts[i - 1];

    // Pass 2 — place positions. `members` holds indices into `groupsData`, not
    // `GroupData.groupId`, so it stays aligned with the writers array, which is
    // built from `groupsData` the same way.
    const members = new Uint32Array(total);
    const cursor = starts.slice();
    for (let g = 0; g < groupsData.length; g++) {
      for (const id of groupsData[g].fileIds) {
        if (id < 0 || id > maxId) continue;
        members[cursor[id]] = g;
        cursor[id] += 1;
      }
    }

    this.starts = starts;
    this.members = members;
    this.maxId = maxId;
  }

  /**
   * Positions in `groupsData` of the groups that include `id`, ascending.
   * Empty if none.
   */
  groupsOf(id: number): Uint32Array {
    if (id < 0 || id > this.maxId) return new Uint32Array(0);
    return this.members.subarray(this.starts[id], this.starts[id + 1]);
  }
}

async function emitSplitLine(
  writers: WritableStreamDefaultWriter[],
  raw: string,
  groupsData: GroupData[],
  idGroups: IdGroupIndex,
): Promise<void> {
  if (raw.charCodeAt(0) !== 35) return; // '#'
  let id = 0;
  for (let i = 1; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      id = id * 10 + (c - 48);
    } else {
      break;
    }
  }
  if (id === 0) return;

  const groups = idGroups.groupsOf(id);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const line = groupsData[g].rewrittenLines.get(id) ?? raw;
    await writers[g].write(`${line}\n`);
  }
}

async function emitExtractLine(
  writer: WritableStreamDefaultWriter,
  raw: string,
  includeSet: IdSet,
  rewrittenLines: Map<number, string>,
): Promise<void> {
  if (raw.charCodeAt(0) !== 35) return; // '#'
  let id = 0;
  for (let i = 1; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      id = id * 10 + (c - 48);
    } else {
      break;
    }
  }
  if (id === 0 || !includeSet.has(id)) return;
  const line = rewrittenLines.get(id) ?? raw;
  await writer.write(`${line}\n`);
}

/**
 * Abort every writer, swallowing secondary failures so the original error is
 * the one that propagates. Aborting an already closed writer rejects — that is
 * expected and ignored.
 */
async function abortWriters(
  writers: WritableStreamDefaultWriter[],
  reason?: unknown,
): Promise<void> {
  await Promise.allSettled(writers.map(async (writer) => writer.abort(reason)));
}

export class IfcSplitter {
  protected readonly io: IfcSplitterIO;
  protected readonly config: IfcSplitterResolvedConfig;
  protected readonly eventTarget: EventTarget;

  constructor(ifcSplitterIO: IfcSplitterIO, config: IfcSplitterConfig = {}) {
    this.io = ifcSplitterIO;
    this.config = {
      elementTypes: new Set(config.elementTypes ?? ELEMENT_TYPES),
      spatialTypes: new Set(config.spatialTypes ?? SPATIAL_TYPES),
      listArgIndex: config.listArgIndex ?? listIdxByType,
    };
    this.eventTarget = new EventTarget();
  }

  readonly onProgress = new Event<IfcSplitterProgressEvent>();

  readonly onSplitsResolved = new Event<IfcSplitterGroupsEvent>();

  /**
   * Fires from `extract` when an id is missing or has a wrong type
   */
  readonly onExtractWarning = new Event<IfcSplitterWarningEvent>();

  /**
   * Fires from `split` and `extract` with the relationships left out because
   * their elements ended up in different files (or, for `extract`, partly
   * outside the output). Empty when there are none.
   */
  readonly onCrossPartRelations = new Event<IfcSplitterCrossPartEvent>();

  /**
   * Split an IFC file into N roughly equal groups of building elements.
   * @param inputPath - Absolute or relative path to the source IFC file.
   * @param numGroups - Number of output files to produce. Not capped by the
   * splitter, but note that the write pass holds one open writer per non-empty
   * group, so the practical ceiling is the process' file descriptor limit.
   * @param outputPath - Given `groupId` returns output file path.
   * @param crossPartRelationsPath - Optional path of a JSON file listing the
   * relationships whose elements ended up in different files, see
   * {@link onCrossPartRelations}.
   * @returns a map keyed by {@link GroupData.groupId}.
   * @throws {RangeError} if `numGroups` is not a positive integer.
   */
  async split(
    inputPath: string,
    numGroups: number,
    outputPath: (groupId: number) => string,
    crossPartRelationsPath?: string,
  ): Promise<Map<number, { path: string; ids: IdSet }>> {
    if (!Number.isInteger(numGroups) || numGroups < 1) {
      throw new RangeError(
        `numGroups must be a positive integer, received ${numGroups}`,
      );
    }

    // 1. Parse
    const parseStart = performance.now();
    const { header, footer, index } = await this.parseIfc(inputPath);
    this.emitProgressEvent("parse", parseStart);

    // 2. Identify spatial structure (shared in all files)
    const spatialStart = performance.now();
    const sharedIds = traverseSpatialStructure(index, this.config.spatialTypes);
    this.emitProgressEvent("spatial", spatialStart);

    // 3. Build void/fill coupling map
    const voidFillStart = performance.now();
    const vfMap = buildVoidFillMap(index);
    this.emitProgressEvent("void-fill", voidFillStart);

    // 3b. Build reverse style maps
    const styleMapsStart = performance.now();
    const styleMaps = buildStyleMaps(index);
    const backward = backwardEntries(index, schemaFamily(header));
    this.emitProgressEvent("style-maps", styleMapsStart);

    // 4. Identify all building elements
    const classifyStart = performance.now();
    const allElementIds = index.getAll(this.config.elementTypes);
    this.emitProgressEvent("classify", classifyStart);

    // 4b. Build aggregation map
    const aggregateStart = performance.now();
    const aggMap = buildAggregateMap(index, allElementIds);
    this.emitProgressEvent("aggregate", aggregateStart);

    // 5. Build clusters
    const clusterStart = performance.now();
    const clusters: number[][] = [];
    const assigned = new Set<number>();
    for (const eid of allElementIds) {
      if (assigned.has(eid)) continue;
      const cluster = getCluster(eid, vfMap, aggMap);
      const elementCluster: number[] = [];
      for (const cid of cluster) {
        if (allElementIds.has(cid)) {
          elementCluster.push(cid);
          assigned.add(cid);
        }
      }
      clusters.push(elementCluster);
    }
    assigned.clear();
    const weights = clusterWeights(clusters, index, sharedIds, allElementIds);
    coupleSpaceContents(clusters, weights, numGroups, index, allElementIds);
    this.emitProgressEvent("cluster", clusterStart);

    // 6. Distribute clusters into N groups (greedy bin packing by weight, so
    // that one huge element does not share a group with other huge ones just
    // because the element counts happen to line up)
    const distributeStart = performance.now();
    const groups: Set<number>[] = Array.from(
      { length: numGroups },
      () => new Set(),
    );
    const clusterOrder = clusters
      .map((_, i) => i)
      .filter((i) => clusters[i].length > 0)
      .sort((a, b) => weights[b] - weights[a]);
    const groupSizes = new Array<number>(numGroups).fill(0);

    for (const ci of clusterOrder) {
      let minIdx = 0;
      for (let g = 1; g < numGroups; g++) {
        if (groupSizes[g] < groupSizes[minIdx]) minIdx = g;
      }
      for (const id of clusters[ci]) groups[minIdx].add(id);
      groupSizes[minIdx] += weights[ci];
    }
    this.emitProgressEvent("distribute", distributeStart);

    // 7. Pre-parse all relationship lines that need per-group rewriting.
    const relationsStart = performance.now();
    const relEntries: RelEntry[] = [];
    for (let id = 0; id <= index.maxId; id++) {
      const type = index.getType(id);
      if (type && shouldRewriteType(type)) {
        const raw = index.getRaw(id);
        const argsStr = extractArgsString(raw);
        if (!argsStr) continue;
        const args = splitIfcArgs(argsStr);
        const listIdx = this.config.listArgIndex(type) ?? -1;
        if (listIdx < 0 || args.length <= listIdx) continue;
        const listRefs = extractRefs(args[listIdx]);
        if (listRefs.length === 0) continue;
        const idMatch = raw!.match(/^(#\d+\s*=\s*)/);
        if (!idMatch) continue;
        relEntries.push({
          id,
          type,
          args,
          listIdx,
          listRefs,
          idPrefix: idMatch[1],
        });
      }
    }
    this.emitProgressEvent("relations", relationsStart);

    // 8. Resolve deps for all groups
    const resolveStart = performance.now();
    const groupsData: GroupData[] = [];
    const groupOf = new Map<number, number>();
    groups.forEach((ids, g) => {
      for (const id of ids) groupOf.set(id, g);
    });
    const claimedBy = claimStructureMembers(
      relEntries,
      groupOf,
      sharedIds,
      allElementIds,
      Math.max(
        0,
        groups.findIndex((ids) => ids.size > 0),
      ),
    );

    const crossPartIds = new Set<number>();

    for (let g = 0; g < numGroups; g++) {
      const groupElementIds = groups[g];
      // A group gets nothing when there are fewer clusters than `numGroups`.
      // Such a group produces no entry and no output file, so `groupsData` is
      // dense and every consumer correlates via `groupId` rather than position.
      if (groupElementIds.size === 0) continue;

      const fileIds = sharedIds.clone();

      for (const eid of groupElementIds) {
        collectDeps(eid, index, fileIds, allElementIds);
      }

      for (const eid of groupElementIds) {
        const rels = vfMap.relLineIds.get(eid);
        if (rels) {
          for (const rid of rels) {
            collectDeps(rid, index, fileIds, allElementIds);
          }
        }
        const aggRels = aggMap.aggregateRelIds.get(eid);
        if (aggRels) {
          for (const rid of aggRels) {
            collectDeps(rid, index, fileIds, allElementIds);
          }
        }
      }

      resolveStyles(fileIds, index, styleMaps, allElementIds);

      const rewrittenLines = new Map<number, string>();
      // Two passes: the second also keeps non-element objects that the first
      // brought into the file, e.g. the type objects of the group's elements,
      // so their material and property relationships are not dropped.
      for (const pass of [1, 2])
        for (const rel of relEntries) {
          if (crossPartIds.has(rel.id)) continue;
          // Keep this group's elements, the shared spatial structure (present in
          // every file) and the non-element objects this group has claimed.
          const filtered = rel.listRefs.filter(
            (r) =>
              groupElementIds.has(r) ||
              sharedIds.has(r) ||
              claimedBy.get(r) === g ||
              (pass === 2 && !allElementIds.has(r) && fileIds.has(r)),
          );
          if (filtered.length === 0) continue;
          if (
            crossesFile(
              rel.id,
              rel.listRefs,
              filtered,
              index,
              allElementIds,
              (id) => groupElementIds.has(id),
            )
          ) {
            crossPartIds.add(rel.id);
            continue;
          }
          const newArgs = [...rel.args];
          newArgs[rel.listIdx] = rewriteListArg(
            rel.args[rel.listIdx],
            filtered,
          );
          const rewritten = `${rel.idPrefix}${rel.type}(${newArgs.join(",")});`;
          rewrittenLines.set(rel.id, rewritten);
          fileIds.add(rel.id);
          collectRelDeps(
            rel.id,
            rel.listRefs,
            filtered,
            index,
            fileIds,
            allElementIds,
          );
        }

      attachBackward(backward, fileIds, index, allElementIds, rewrittenLines);
      resolveStyles(fileIds, index, styleMaps, allElementIds);

      const totalIds = fileIds.size;
      groupsData.push({
        groupId: g,
        fileIds,
        rewrittenLines,
        elementCount: groupElementIds.size,
        totalIds,
        filePath: outputPath(g),
      });
    }

    const crossPartRelations = [...crossPartIds]
      .sort((a, b) => a - b)
      .map((id) =>
        describeCrossPartRelation(
          id,
          index,
          allElementIds,
          (eid) => groupOf.get(eid) ?? null,
        ),
      );

    this.emitProgressEvent("resolve", resolveStart);
    this.onSplitsResolved.trigger({ data: groupsData });
    this.onCrossPartRelations.trigger({ relations: crossPartRelations });

    // Free the index to reclaim memory before the output pass
    const maxParsedId = index.maxId;
    index.free();

    // 9. Invert fileIds into an id -> groups index for O(1) write-phase lookups
    const buildIndexStart = performance.now();
    const idGroups = new IdGroupIndex(groupsData, maxParsedId);
    this.emitProgressEvent("build-index", buildIndexStart);

    // 10. Second pass: write output files
    const writeStart = performance.now();
    await this.writeSplitOutput(
      inputPath,
      header,
      footer,
      groupsData,
      idGroups,
    );
    if (crossPartRelationsPath !== undefined) {
      await this.writeCrossPartRelations(
        crossPartRelationsPath,
        inputPath,
        new Map(groupsData.map(({ groupId, filePath }) => [groupId, filePath])),
        crossPartRelations,
      );
    }
    this.emitProgressEvent("write", writeStart);

    return new Map(
      groupsData.map(({ groupId, filePath, fileIds }) => [
        groupId,
        { path: filePath, ids: fileIds },
      ]),
    );
  }

  /**
   * Extract specific building elements from an IFC file into a new IFC file.
   * @param inputPath  - Absolute or relative path to the source IFC file.
   * @param elementIds - Array of IFC entity IDs (`#id`) for the building elements to extract. Non-element or missing IDs are skipped, each reported through {@link onExtractWarning}.
   * @param outputPath - Path for the output IFC file.
   * @param crossPartRelationsPath - Optional path of a JSON file listing the
   * relationships left out because they reference elements that were not
   * extracted, see {@link onCrossPartRelations}.
   * @throws {Error} if none of `elementIds` resolves to a building element. No
   * output file is produced in that case.
   */
  async extract(
    inputPath: string,
    elementIds: number[],
    outputPath: string,
    crossPartRelationsPath?: string,
  ): Promise<IdSet> {
    // 1. Parse
    const parseStart = performance.now();
    const { header, footer, index } = await this.parseIfc(inputPath);
    this.emitProgressEvent("parse", parseStart);

    // 2. Identify spatial structure (shared)
    const spatialStart = performance.now();
    const sharedIds = traverseSpatialStructure(index, this.config.spatialTypes);
    this.emitProgressEvent("spatial", spatialStart);

    // 3. Build maps
    const voidFillStart = performance.now();
    const vfMap = buildVoidFillMap(index);
    this.emitProgressEvent("void-fill", voidFillStart);

    const styleMapsStart = performance.now();
    const styleMaps = buildStyleMaps(index);
    const backward = backwardEntries(index, schemaFamily(header));
    this.emitProgressEvent("style-maps", styleMapsStart);

    const classifyStart = performance.now();
    const allElementIds = index.getAll(this.config.elementTypes);
    this.emitProgressEvent("classify", classifyStart);

    // 4. Cluster: expand void/fill + aggregation for requested elements
    const aggregateStart = performance.now();
    const aggMap = buildAggregateMap(index, allElementIds);
    this.emitProgressEvent("aggregate", aggregateStart);

    const clusterStart = performance.now();

    // Validate requested IDs
    const requestedIds = new Set<number>();
    for (const eid of elementIds) {
      if (allElementIds.has(eid)) {
        requestedIds.add(eid);
      } else if (index.has(eid)) {
        const type = index.getType(eid);
        this.onExtractWarning.trigger({
          message: `Skipping #${eid}: type '${type}' is not a building element`,
          context: { id: eid, type },
        });
      } else {
        this.onExtractWarning.trigger({
          message: `Skipping #${eid}: not found`,
          context: { id: eid },
        });
      }
    }
    if (requestedIds.size === 0) {
      throw new Error("No valid element IDs found.");
    }

    const groupElementIds = new Set<number>(requestedIds);
    for (const eid of requestedIds) {
      const cluster = getCluster(eid, vfMap, aggMap);
      for (const cid of cluster) {
        if (allElementIds.has(cid)) groupElementIds.add(cid);
      }
    }
    this.emitProgressEvent("cluster", clusterStart);

    // 5. Rewrite relationship lines
    const relationsStart = performance.now();
    const fileIds = sharedIds.clone();
    const rewrittenLines = new Map<number, string>();
    const crossPartIds = new Set<number>();
    // Run twice: before and after collecting the elements' dependencies, so
    // that the second run also keeps non-element objects now in the file
    // (e.g. type objects) in a relationship's list.
    const rewriteRelations = (keepPresent: boolean) => {
      for (let id = 0; id <= index.maxId; id++) {
        const type = index.getType(id);
        if (type && shouldRewriteType(type) && !crossPartIds.has(id)) {
          const raw = index.getRaw(id);
          const argsStr = extractArgsString(raw);
          if (!argsStr) continue;
          const args = splitIfcArgs(argsStr);
          const listIdx = this.config.listArgIndex(type) ?? -1;
          if (listIdx < 0 || args.length <= listIdx) continue;
          const listRefs = extractRefs(args[listIdx]);
          if (listRefs.length === 0) continue;

          const filtered = listRefs.filter(
            (r) =>
              groupElementIds.has(r) ||
              sharedIds.has(r) ||
              (keepPresent && !allElementIds.has(r) && fileIds.has(r)),
          );
          if (filtered.length === 0) continue;
          if (
            crossesFile(id, listRefs, filtered, index, allElementIds, (eid) =>
              groupElementIds.has(eid),
            )
          ) {
            crossPartIds.add(id);
            continue;
          }

          const idMatch = raw!.match(/^(#\d+\s*=\s*)/);
          if (!idMatch) continue;
          const newArgs = [...args];
          newArgs[listIdx] = rewriteListArg(args[listIdx], filtered);
          rewrittenLines.set(id, `${idMatch[1]}${type}(${newArgs.join(",")});`);
          fileIds.add(id);
          collectRelDeps(id, listRefs, filtered, index, fileIds, allElementIds);
        }
      }
    };
    rewriteRelations(false);
    this.emitProgressEvent("relations", relationsStart);

    // 6. Collect all dependencies
    const resolveStart = performance.now();
    for (const eid of groupElementIds) {
      collectDeps(eid, index, fileIds, allElementIds);
    }
    for (const eid of groupElementIds) {
      const rels = vfMap.relLineIds.get(eid);
      if (rels) {
        for (const rid of rels) collectDeps(rid, index, fileIds, allElementIds);
      }
      const aggRels = aggMap.aggregateRelIds.get(eid);
      if (aggRels) {
        for (const rid of aggRels)
          collectDeps(rid, index, fileIds, allElementIds);
      }
    }
    resolveStyles(fileIds, index, styleMaps, allElementIds);
    rewriteRelations(true);
    attachBackward(backward, fileIds, index, allElementIds, rewrittenLines);
    resolveStyles(fileIds, index, styleMaps, allElementIds);

    const crossPartRelations = [...crossPartIds]
      .sort((a, b) => a - b)
      .map((id) =>
        describeCrossPartRelation(id, index, allElementIds, (eid) =>
          groupElementIds.has(eid) ? 0 : null,
        ),
      );
    this.emitProgressEvent("resolve", resolveStart);
    this.onCrossPartRelations.trigger({ relations: crossPartRelations });

    // 7. Free index, write output
    index.free();

    const writeStart = performance.now();
    const writer = (await this.io.writableStream(outputPath)).getWriter();
    let closed = false;
    try {
      await writer.write(`${header.join("\n")}\n`);

      let section: "header" | "data" | "footer" = "header";
      let accumulator = "";

      await this.forEachLine(inputPath, async (line: string) => {
        if (section === "header") {
          if (line.trim() === "DATA;") section = "data";
          return;
        }
        if (section === "data") {
          const trimmed = line.trim();
          if (trimmed === "ENDSEC;") {
            if (accumulator) {
              await emitExtractLine(
                writer,
                accumulator,
                fileIds,
                rewrittenLines,
              );
              accumulator = "";
            }
            section = "footer";
            return;
          }

          if (!accumulator && trimmed.charCodeAt(trimmed.length - 1) === 59) {
            await emitExtractLine(writer, trimmed, fileIds, rewrittenLines);
            return;
          }

          accumulator += (accumulator ? " " : "") + trimmed;
          if (accumulator.charCodeAt(accumulator.length - 1) === 59) {
            await emitExtractLine(writer, accumulator, fileIds, rewrittenLines);
            accumulator = "";
          }
        }
      });

      await writer.write(`${footer.join("\n")}\n`);
      await writer.close();
      closed = true;
    } finally {
      // Reading or writing may reject mid-stream; release the sink either way.
      if (!closed) await abortWriters([writer]);
    }
    if (crossPartRelationsPath !== undefined) {
      await this.writeCrossPartRelations(
        crossPartRelationsPath,
        inputPath,
        new Map([[0, outputPath]]),
        crossPartRelations,
      );
    }
    this.emitProgressEvent("write", writeStart);

    return fileIds;
  }

  async parseIfc(filePath: string): Promise<ParseResult> {
    const header: string[] = [];
    const footer: string[] = [];
    const index = new LineIndex();
    const remember = (id: number, type: string, raw: string) => {
      if (this.config.elementTypes.has(type)) {
        index.guids.set(id, guidOfRaw(raw));
      }
    };

    let section: "header" | "data" | "footer" = "header";
    let accumulator = "";
    let lineCount = 0;

    await this.forEachLine(filePath, (line: string) => {
      if (section === "header") {
        header.push(line);
        if (line.trim() === "DATA;") section = "data";
        return;
      }
      if (section === "data") {
        const trimmed = line.trim();
        if (trimmed === "ENDSEC;") {
          if (accumulator) {
            const info = extractLineMeta(accumulator);
            if (info) {
              const refs = extractRefs(accumulator, info.id);
              index.set(info.id, info.type, refs, accumulator);
              remember(info.id, info.type, accumulator);
              lineCount++;
            }
            accumulator = "";
          }
          section = "footer";
          footer.push(line);
          return;
        }
        accumulator += (accumulator ? " " : "") + trimmed;
        if (accumulator.charCodeAt(accumulator.length - 1) === 59) {
          // ';'
          const info = extractLineMeta(accumulator);
          if (info) {
            const refs = extractRefs(accumulator, info.id);
            index.set(info.id, info.type, refs, accumulator);
            remember(info.id, info.type, accumulator);
            lineCount++;
          }
          accumulator = "";
        }
        return;
      }
      footer.push(line);
    });

    index.finalize();

    return { header, footer, index };
  }

  /**
   * Chunked file reader — replaces readline (3-5x faster)
   */
  async forEachLine(
    filePath: string,
    callback: (line: string) => void | Promise<void>,
  ): Promise<void> {
    const readableStream = await this.io.readableStream(filePath);

    for await (const line of streamAsyncIterator(readableStream)) {
      await callback(line);
    }
  }

  protected async writeSplitOutput(
    inputPath: string,
    header: string[],
    footer: string[],
    groupsData: GroupData[],
    idGroups: IdGroupIndex,
  ): Promise<void> {
    const headerStr = `${header.join("\n")}\n`;
    const writers = await this.openGroupWriters(groupsData, headerStr);

    let section: "header" | "data" | "footer" = "header";
    let accumulator = "";
    let closed = false;

    try {
      await this.forEachLine(inputPath, async (line: string) => {
        if (section === "header") {
          if (line.trim() === "DATA;") section = "data";
          return;
        }
        if (section === "data") {
          const trimmed = line.trim();
          if (trimmed === "ENDSEC;") {
            if (accumulator) {
              await emitSplitLine(writers, accumulator, groupsData, idGroups);
              accumulator = "";
            }
            section = "footer";
            return;
          }

          if (!accumulator && trimmed.charCodeAt(trimmed.length - 1) === 59) {
            await emitSplitLine(writers, trimmed, groupsData, idGroups);
            return;
          }

          accumulator += (accumulator ? " " : "") + trimmed;
          if (accumulator.charCodeAt(accumulator.length - 1) === 59) {
            await emitSplitLine(writers, accumulator, groupsData, idGroups);
            accumulator = "";
          }
        }
      });

      const footerStr = `${footer.join("\n")}\n`;
      await Promise.all(
        writers.map(async (writer) => {
          await writer.write(footerStr);
          await writer.close();
        }),
      );
      closed = true;
    } finally {
      // Any read/write rejection leaves every sink open — abort them all rather
      // than leaking one file handle per group.
      if (!closed) await abortWriters(writers);
    }
  }

  /**
   * Open one writer per non-empty group and prime it with the header. If any
   * writer fails to open, the ones already opened are aborted before rethrowing.
   */
  private async openGroupWriters(
    groupsData: GroupData[],
    headerStr: string,
  ): Promise<WritableStreamDefaultWriter[]> {
    const settled = await Promise.allSettled(
      groupsData.map(async (groupData) => {
        const writer = (
          await this.io.writableStream(groupData.filePath)
        ).getWriter();
        await writer.write(headerStr);
        return writer;
      }),
    );

    const opened = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      await abortWriters(opened, failure.reason);
      throw failure.reason;
    }
    return opened;
  }

  /**
   * Writes the cross-part relationships as JSON:
   * `{ format, version, source, parts: { [groupId]: path }, relations }`.
   */
  protected async writeCrossPartRelations(
    path: string,
    inputPath: string,
    parts: Map<number, string>,
    relations: IfcSplitterCrossPartRelation[],
  ): Promise<void> {
    const writer = (await this.io.writableStream(path)).getWriter();
    let closed = false;
    try {
      const head = {
        format: "ifc-splitter-cross-part-relations",
        version: 1,
        source: inputPath,
        parts: Object.fromEntries(parts),
      };
      const headJson = JSON.stringify(head, null, 1);
      await writer.write(`${headJson.slice(0, -2)},\n "relations": [`);
      for (let i = 0; i < relations.length; i++) {
        await writer.write(
          `${i ? "," : ""}\n  ${JSON.stringify(relations[i])}`,
        );
      }
      await writer.write("\n ]\n}\n");
      await writer.close();
      closed = true;
    } finally {
      if (!closed) await abortWriters([writer]);
    }
  }

  protected emitProgressEvent(stage: IfcSplitterStage, start: number) {
    this.onProgress.trigger({
      stage,
      timeElapsed: performance.now() - start,
    });
  }
}
