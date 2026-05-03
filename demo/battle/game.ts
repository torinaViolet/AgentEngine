//========================
//  精灵对战 — 游戏引擎
// ========================

/**属性类型 */
export type ElementType = "fire" | "water" | "grass" | "electric" | "ice" | "dark" | "normal";

/** 技能模板 */
export interface MoveTemplate {
  name: string;
  type: ElementType;
  power: number;
  accuracy: number;
  maxPp: number;
}

/** 精灵模板 */
export interface MonsterTemplate {
  id: string;
  name: string;
  type: ElementType;
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;
  moves: MoveTemplate[]; description: string;
}

/** 战斗中的精灵状态 */
export interface MonsterState {
  templateId: string;
  currentHp: number;
  pp: number[];
}

/** 技能执行结果 */
export interface MoveResult {
  attacker: string;
  defender: string;
  moveName: string;
  moveType: ElementType;
  damage: number;
  effectiveness: "super" | "resist" | "normal";
  critical: boolean;
  missed: boolean;
  defenderHp: number;
  defenderMaxHp: number;
  fainted: boolean;
  message: string;
}

/** 对战状态 */
export interface BattleSnapshot {
  player: MonsterState;
  enemy: MonsterState;
  playerTemplate: MonsterTemplate;
  enemyTemplate: MonsterTemplate;
  turn: number;
  isOver: boolean;
  winner?: "player" | "enemy";
}

// ========================
//  属性克制表
// ========================

const TYPE_CHART: Record<ElementType, Partial<Record<ElementType, number>>> = {
  fire: { grass: 2, ice: 2, water: 0.5, fire: 0.5 },
  water: { fire: 2, water: 0.5, grass: 0.5 },
  grass: { water: 2, fire: 0.5, grass: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5 },
  ice: { grass: 2, electric: 2, fire: 0.5, ice: 0.5, water: 0.5 },
  dark: { ice: 2, dark: 0.5 },
  normal: {},
};

export function getTypeEffectiveness(atkType: ElementType, defType: ElementType): number {
  return TYPE_CHART[atkType]?.[defType] ?? 1;
}

export function getTypeLabel(e: "super" | "resist" | "normal"): string {
  if (e === "super") return "效果拔群！";
  if (e === "resist") return "效果不太好...";
  return "";
}

// ========================
//  精灵数据
// ========================

export const MONSTERS: MonsterTemplate[] = [
  {
    id: "pyrix", name: "焰灵", type: "fire",
    maxHp: 90, attack: 75, defense: 50, speed: 70,
    description: "浑身燃烧着不灭火焰的精灵，性格热情而勇猛。",
    moves: [
      { name: "烈焰冲击", type: "fire", power: 80, accuracy: 90, maxPp: 10 },
      { name: "火花", type: "fire", power: 40, accuracy: 100, maxPp: 25 },
      { name: "利爪", type: "normal", power: 55, accuracy: 95, maxPp: 25 },
      { name: "电光一闪", type: "normal", power: 40, accuracy: 100, maxPp: 30 },
    ],
  },
  {
    id: "aqualis", name: "水灵", type: "water",
    maxHp: 100, attack: 60, defense: 70, speed: 55,
    description: "栖息于深海的温柔精灵，防御力出众。",
    moves: [
      { name: "水炮", type: "water", power: 80, accuracy: 90, maxPp: 10 },
      { name: "水枪", type: "water", power: 40, accuracy: 100, maxPp: 25 },
      { name: "冲撞", type: "normal", power: 55, accuracy: 95, maxPp: 25 },
      { name: "电光一闪", type: "normal", power: 40, accuracy: 100, maxPp: 30 },
    ],
  },
  {
    id: "florix", name: "花灵", type: "grass",
    maxHp: 95, attack: 65, defense: 65, speed: 60,
    description: "头顶绽放鲜花的森林精灵，攻守平衡。",
    moves: [
      { name: "飞叶风暴", type: "grass", power: 80, accuracy: 90, maxPp: 10 },
      { name: "藤鞭", type: "grass", power: 40, accuracy: 100, maxPp: 25 },
      { name: "冲撞", type: "normal", power: 55, accuracy: 95, maxPp: 25 },
      { name: "电光一闪", type: "normal", power: 40, accuracy: 100, maxPp: 30 },
    ],
  },
  {
    id: "sparkix", name: "雷灵", type: "electric",
    maxHp: 80, attack: 70, defense: 45, speed: 90,
    description: "速度极快的闪电精灵，擅长先发制人。",
    moves: [
      { name: "雷电", type: "electric", power: 80, accuracy: 90, maxPp: 10 },
      { name: "电击", type: "electric", power: 40, accuracy: 100, maxPp: 25 },
      { name: "利爪", type: "normal", power: 55, accuracy: 95, maxPp: 25 },
      { name: "电光一闪", type: "normal", power: 40, accuracy: 100, maxPp: 30 },
    ],
  },
  {
    id: "frostix", name: "冰灵", type: "ice",
    maxHp: 85, attack: 70, defense: 60, speed: 50,
    description: "诞生于极寒冰川的水晶精灵，攻击力不俗。",
    moves: [
      { name: "冰冻光线", type: "ice", power: 80, accuracy: 90, maxPp: 10 },
      { name: "冰风", type: "ice", power: 40, accuracy: 100, maxPp: 25 },
      { name: "冲撞", type: "normal", power: 55, accuracy: 95, maxPp: 25 },
      { name: "电光一闪", type: "normal", power: 40, accuracy: 100, maxPp: 30 },
    ],
  },
  {
    id: "shadox", name: "暗灵", type: "dark",
    maxHp: 88, attack: 80, defense: 55, speed: 65,
    description: "潜伏于暗影中的神秘精灵，攻击力最强。",
    moves: [
      { name: "暗影球", type: "dark", power: 80, accuracy: 90, maxPp: 10 },
      { name: "暗影突袭", type: "dark", power: 40, accuracy: 100, maxPp: 25 },
      { name: "利爪", type: "normal", power: 55, accuracy: 95, maxPp: 25 },
      { name: "电光一闪", type: "normal", power: 40, accuracy: 100, maxPp: 30 },
    ],
  },
];

export function getMonster(id: string): MonsterTemplate {
  const m = MONSTERS.find((m) => m.id === id);
  if (!m) throw new Error(`未知精灵: ${id}`);
  return m;
}

// ========================
//  对战引擎
// ========================

export class Battle {
  private _player: MonsterState;
  private _enemy: MonsterState;
  private _playerTemplate: MonsterTemplate;
  private _enemyTemplate: MonsterTemplate;
  private _turn: number = 0;
  private _isOver: boolean = false;
  private _winner?: "player" | "enemy";

  constructor(playerId: string, enemyId: string) {
    this._playerTemplate = getMonster(playerId);
    this._enemyTemplate = getMonster(enemyId);
    this._player = {
      templateId: playerId,
      currentHp: this._playerTemplate.maxHp,
      pp: this._playerTemplate.moves.map((m) => m.maxPp),
    };
    this._enemy = {
      templateId: enemyId,
      currentHp: this._enemyTemplate.maxHp,
      pp: this._enemyTemplate.moves.map((m) => m.maxPp),
    };
  }

  /**
   * 从快照恢复对战状态（用于回溯功能）
   *
   * 创建一个新 Battle，然后从 snapshot 覆盖所有可变状态，
   * 模板通过 ID 重新查找（与原 Battle 一致）。
   */
  static fromSnapshot(snapshot: BattleSnapshot): Battle {
    const battle = new Battle(snapshot.playerTemplate.id, snapshot.enemyTemplate.id);
    battle._player = { ...snapshot.player, pp: [...snapshot.player.pp] };
    battle._enemy = { ...snapshot.enemy, pp: [...snapshot.enemy.pp] };
    battle._turn = snapshot.turn;
    battle._isOver = snapshot.isOver;
    battle._winner = snapshot.winner;
    return battle;
  }

  /** 获取快照 */
  snapshot(): BattleSnapshot {
    return {
      player: { ...this._player, pp: [...this._player.pp] },
      enemy: { ...this._enemy, pp: [...this._enemy.pp] },
      playerTemplate: this._playerTemplate,
      enemyTemplate: this._enemyTemplate,
      turn: this._turn,
      isOver: this._isOver,
      winner: this._winner,
    };
  }

  get isOver(): boolean { return this._isOver; }
  get winner(): string | undefined { return this._winner; }
  get turn(): number { return this._turn; }

  /** 增加回合数 */
  nextTurn(): void { this._turn++; }

  /** 执行技能 */
  executeMove(side: "player" | "enemy", moveName: string): MoveResult {
    const attacker = side === "player" ? this._player : this._enemy;
    const defender = side === "player" ? this._enemy : this._player;
    const atkTemplate = side === "player" ? this._playerTemplate : this._enemyTemplate;
    const defTemplate = side === "player" ? this._enemyTemplate : this._playerTemplate;

    // 找技能
    const moveIndex = atkTemplate.moves.findIndex((m) => m.name === moveName);
    if (moveIndex === -1) {
      return this.makeMissResult(atkTemplate.name, defTemplate.name, moveName, "normal", defender, defTemplate);
    }

    const move = atkTemplate.moves[moveIndex];

    // PP 检查
    if (attacker.pp[moveIndex] <= 0) {
      return {
        attacker: atkTemplate.name,
        defender: defTemplate.name,
        moveName: move.name,
        moveType: move.type,
        damage: 0,
        effectiveness: "normal",
        critical: false,
        missed: true,
        defenderHp: defender.currentHp,
        defenderMaxHp: defTemplate.maxHp,
        fainted: false,
        message: `${atkTemplate.name}的${move.name}已经没有PP了！`,
      };
    }

    // 消耗 PP
    attacker.pp[moveIndex]--;

    // 命中判定
    if (Math.random() * 100 >= move.accuracy) {
      return this.makeMissResult(atkTemplate.name, defTemplate.name, move.name, move.type, defender, defTemplate);
    }

    // 伤害计算
    const typeMultiplier = getTypeEffectiveness(move.type, defTemplate.type);
    const critical = Math.random() < 0.08;
    const critMultiplier = critical ? 1.5 : 1.0;
    const randomFactor = 0.85 + Math.random() * 0.15;

    const baseDamage = (move.power * atkTemplate.attack / defTemplate.defense) * 0.4 + 2;
    const finalDamage = Math.max(1, Math.floor(baseDamage * typeMultiplier * critMultiplier * randomFactor));

    defender.currentHp = Math.max(0, defender.currentHp - finalDamage);
    const fainted = defender.currentHp <= 0;

    if (fainted) {
      this._isOver = true;
      this._winner = side;
    }

    const effectiveness: "super" | "resist" | "normal" =
      typeMultiplier > 1 ? "super" : typeMultiplier < 1 ? "resist" : "normal";

    let message = `${atkTemplate.name}使用了${move.name}！`;
    if (effectiveness === "super") message += " 效果拔群！";
    if (effectiveness === "resist") message += " 效果不太好...";
    if (critical) message += " 击中了要害！";
    message += ` 造成了${finalDamage}点伤害！`;
    if (fainted) message += ` ${defTemplate.name}倒下了！`;

    return {
      attacker: atkTemplate.name,
      defender: defTemplate.name,
      moveName: move.name,
      moveType: move.type,
      damage: finalDamage,
      effectiveness,
      critical,
      missed: false,
      defenderHp: defender.currentHp,
      defenderMaxHp: defTemplate.maxHp,
      fainted,
      message,
    };
  }

  /** 生成AI视角的战场描述 */
  describeForAI(): string {
    const e = this._enemy;
    const p = this._player;
    const et = this._enemyTemplate;
    const pt = this._playerTemplate;

    const myMoves = et.moves.map((m, i) => {
      const eff = getTypeEffectiveness(m.type, pt.type);
      const effLabel = eff > 1 ? "(克制)" : eff < 1 ? "(被抵抗)" : "";
      return `  - ${m.name} [${m.type}属性, 威力${m.power}, 命中${m.accuracy}, PP${e.pp[i]}/${m.maxPp}] ${effLabel}`;
    }).join("\n");

    return [
      `=== 第${this._turn}回合 ===`,
      ``,
      `【我方】${et.name} (${et.type}属性)`,
      `  HP: ${e.currentHp}/${et.maxHp}`,
      `  攻击:${et.attack} 防御:${et.defense} 速度:${et.speed}`,
      `  可用技能:`,
      myMoves,
      ``, `【对手】${pt.name} (${pt.type}属性)`,
      `  HP: ${p.currentHp}/${pt.maxHp}`,
      `  攻击:${pt.attack} 防御:${pt.defense} 速度:${pt.speed}`,
      ``, `属性克制提示:` + this.typeHints(et.type, pt.type),
    ].join("\n");
  }

  private typeHints(myType: ElementType, opponentType: ElementType): string {
    const hints: string[] = [];
    for (const move of this._enemyTemplate.moves) {
      const eff = getTypeEffectiveness(move.type, opponentType);
      if (eff > 1) hints.push(`${move.name}对${this._playerTemplate.name}效果拔群(${eff}x)`);
      if (eff < 1) hints.push(`${move.name}对${this._playerTemplate.name}效果不好(${eff}x)`);
    }
    return hints.length > 0 ? hints.join("; ") : "无特殊克制关系";
  }

  private makeMissResult(atkName: string, defName: string, moveName: string, moveType: ElementType,
    defender: MonsterState, defTemplate: MonsterTemplate
  ): MoveResult {
    return {
      attacker: atkName, defender: defName, moveName, moveType,
      damage: 0, effectiveness: "normal", critical: false, missed: true,
      defenderHp: defender.currentHp, defenderMaxHp: defTemplate.maxHp,
      fainted: false, message: `${atkName}的${moveName}没有命中！`,
    };
  }
}