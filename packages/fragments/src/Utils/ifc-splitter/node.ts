#!/usr/bin/env node
import { openAsBlob } from "fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { IfcDecoderStream } from "../ifc-stream";
import { IfcSplitter, IfcSplitterConfig } from "./index";

export class IfcSplitterNode extends IfcSplitter {
  constructor(config?: IfcSplitterConfig) {
    super(
      {
        readableStream: async (path) =>
          (await openAsBlob(path, { type: "text/plain" }))
            .stream()
            // byte for byte: an exporter's raw UTF-8 or ISO 8859-1 text
            // comes out exactly as it went in
            .pipeThrough(new IfcDecoderStream("binary")),

        writableStream: async (path) => {
          await mkdir(dirname(path), { recursive: true });
          const fileHandle = await open(path, "w");
          const nodeWritable = fileHandle.createWriteStream({
            encoding: "latin1",
          });
          return Writable.toWeb(nodeWritable) as WritableStream<string>;
        },
      },
      config,
    );
  }
}
