import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";
import protoSource from "./imboss.proto?raw";

/**
 * The gRPC service definition, generated from `imboss.proto` at module load.
 *
 * Why reflection instead of `@grpc/proto-loader`: proto-loader needs a `.proto`
 * *file path* at runtime, which has three different shapes (dev tree, inside the
 * asar, and the remote zip). The contract is inlined into the bundle as a string
 * (`?raw`) and parsed here, so server and client behave identically everywhere
 * with no file lookup and no generated code to keep in sync.
 *
 * Field names are protobufjs's default camelCase (`argsJson`, `hasResult`, …).
 */

/** Fully-qualified service name used in every gRPC method path. */
export const IMBOSS_SERVICE_NAME = "imboss.v1.Imboss";

/** Version of the channel contract; see `InfoReply.apiVersion`. */
export const IMBOSS_API_VERSION = 2;

const root = protobuf.parse(protoSource).root;
root.resolveAll();

type MessageType = protobuf.Type;

/** Serialize a plain object into protobuf bytes. */
function encode(type: MessageType, value: unknown): Buffer {
  // `fromObject` tolerates missing/extra fields; the schema is a transport
  // envelope, not a validator (channel handlers keep doing the real checking).
  const message = type.fromObject((value ?? {}) as Record<string, unknown>);
  return Buffer.from(type.encode(message).finish());
}

/** Deserialize protobuf bytes into a plain object with defaults filled in. */
function decode(type: MessageType, buffer: Buffer): unknown {
  return type.toObject(type.decode(buffer), {
    defaults: true,
    arrays: true,
    objects: true,
    longs: Number,
    bytes: Buffer,
    enums: String,
  });
}

const service = root.lookupService(IMBOSS_SERVICE_NAME);

/**
 * `@grpc/grpc-js` needs one `MethodDefinition` per method; deriving them from
 * the same reflection data keeps the definition and the `.proto` in lockstep.
 */
export const imbossServiceDefinition: grpc.ServiceDefinition =
  Object.fromEntries(
    Object.entries(service.methods).map(([name, method]) => {
      const requestType = method.resolvedRequestType;
      const responseType = method.resolvedResponseType;
      if (!requestType || !responseType) {
        throw new Error(`gRPC method ${name} has an unresolved message type.`);
      }
      return [
        name,
        {
          path: `/${service.fullName.replace(/^\./, "")}/${name}`,
          requestStream: Boolean(method.requestStream),
          responseStream: Boolean(method.responseStream),
          requestSerialize: (value: unknown) => encode(requestType, value),
          requestDeserialize: (buffer: Buffer) => decode(requestType, buffer),
          responseSerialize: (value: unknown) => encode(responseType, value),
          responseDeserialize: (buffer: Buffer) => decode(responseType, buffer),
        },
      ];
    }),
  ) as unknown as grpc.ServiceDefinition;
