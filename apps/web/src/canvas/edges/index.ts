// Public surface of Job 011's connection/waypoint UI.
export { ConnectionEdge } from "./ConnectionEdge";
export {
  WILDCARD_PART,
  connectPorts,
  isValidPortConnection,
  parsePortHandleId,
  reconnectEdge,
  resolveEdgeEndpoints,
  type ConnectionLike,
  type PortInfo,
  type ResolvedEndpoints,
} from "./connectionLogic";
export { buildPolyline, nearestSegmentIndex, pointAtT, polylineLength, toPathD, type Point } from "./edgeGeometry";
export { useConnectionHandlers, type ConnectionHandlers } from "./useConnectionHandlers";
// Job 027: connection style rendering (Direct/Curves/Horizontal).
export {
  buildStyledPath,
  buildStyledPathD,
  commandsToPathD,
  resolveConnectionStyle,
  CONNECTION_STYLE_OPTIONS,
  type ConnectionStyleName,
  type PathCommand,
} from "./connectionStyle";
