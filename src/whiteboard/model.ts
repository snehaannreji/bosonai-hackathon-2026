export const BOARD_WIDTH = 640;
export const BOARD_HEIGHT = 480;
export type Point = { x: number; y: number };
export type DrawTool = "pen" | "eraser" | "line" | "arrow" | "rectangle" | "circle" | "text";
export interface Mark {
  id?: string;
  owner?: "ai" | "user";
  tool: DrawTool;
  color: string;
  width: number;
  points: Point[];
  text?: string;
}
