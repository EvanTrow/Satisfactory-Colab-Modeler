// Public surface of Job 011's connection/waypoint UI.
export { ConnectionEdge } from "./ConnectionEdge";
export {
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
