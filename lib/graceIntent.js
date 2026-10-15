// Unicode word boundaries matter here: JavaScript's \b does not delimit Cyrillic.
const WORD = String.raw`\p{L}\p{M}\p{N}_`;
const words = (source) => new RegExp(`(?<![${WORD}])(?:${source})(?![${WORD}])`, "u");
const normalize = (value) => typeof value === "string"
  ? value.normalize("NFKC").toLowerCase().replace(/ё/gu, "е").trim()
  : "";

const MENTION = new RegExp(`(?<![${WORD}@])@(?:grace|грейс)(?![${WORD}])`, "u");
const BRAND = words(String.raw`grace\s+plan`);
const URL = /(?:https?:\/\/|www\.)[^\s<>"']+/gu;
const FILENAME = /[^\s<>"'/:\\]+\.(?:pdf|png|jpe?g|webp|gif|svg|heic|tiff?|bmp|dwg|dxf|ifc|rvt|zip|docx?|xlsx?|txt|json|m?js|tsx?|html|mp4|mov)(?![\p{L}\p{M}\p{N}_])/gu;

// Accept classified visual evidence, never a suggestive filename, URL, caption,
// room list, or the mere presence/count of attachments. Unknown kinds stay general.
const RELEVANT_KIND = /^(?:(?:(?:2d|2 d) )?(?:plan|floor ?plan|floor plan drawing|architectural plan|building plan|site plan|blueprint|architectural drawing)|(?:interior|exterior)(?: (?:photo|photograph|photography|view|scene))?|(?:room|building)(?: (?:interior|exterior|photo|photograph))?|facade|план(?: этажа| поверху| помещения| приміщення| здания| будівлі| будинку)?|(?:2d |2 d )?план этажа|планировка|планування|чертеж(?: плана| здания)?|креслення(?: плану| будівлі)?|интерьер|інтер['’]?єр|экстерьер|екстер['’]?єр|фасад|фото (?:интерьера|інтер['’]?єру|помещения|приміщення))$/u;

/** Whether a per-photo vision classification belongs to the Grace workflow. */
export function isArchitecturalObservation(photo) {
  if (!photo || typeof photo !== "object" || Array.isArray(photo)) return false;
  const kind = normalize(photo.observations?.kind ?? photo.kind).replace(/[\s_-]+/gu, " ");
  return RELEVANT_KIND.test(kind) || /^(corridor|stairs|technical)$/.test(kind);
}

/** A plan is a drawing, never an interior/exterior photograph. */
export function isPlanObservation(photo) {
  if (!photo || typeof photo !== "object" || Array.isArray(photo)) return false;
  const kind = normalize(photo.observations?.kind ?? photo.kind).replace(/[\s_-]+/gu, " ");
  return /^(?:(?:(?:2d|2 d) )?(?:plan|floor ?plan|floor plan drawing|architectural plan|building plan|site plan|blueprint|architectural drawing)|план(?: этажа| поверху| помещения| приміщення| здания| будівлі| будинку)?|планировка|планування|чертеж(?: плана| здания)?|креслення(?: плану| будівлі)?)$/u.test(kind);
}

const ARCHITECTURE = words(String.raw`floor[\s-]*plans?|site[\s-]+plans?|blueprints?|architectural\s+(?:plans?|drawings?|design|visuali[sz]ation)|(?:building|house|apartment|room|office)\s+(?:plans?|layouts?|design)|(?:plans?|layouts?)\s+(?:of|for)\s+(?:(?:the|a|an)\s+)?(?:floor|building|house|apartment|room|office)|план(?:а|у|ом|е|ы|и|ів|ов)?\s+(?:этажа|этажей|поверху|поверхів|помещения|помещений|приміщення|приміщень|здания|зданий|будівлі|будівель|будинку|дома|квартиры|квартири|комнаты|кімнати)|перепланировк[а-я]*|переплануванн[яюі]|bim|ifc`);
const BUILDING = words(String.raw`buildings?|houses?|apartments?|rooms?|offices?|floors?|walls?|doors?|windows?|ceilings?|facades?|interiors?|exteriors?|этаж[а-я]*|поверх(?:у|ів|и)?|здани[а-я]*|будівл[а-яіїє]*|будин[а-яіїє]*|дом(?:а|ов|е)?|квартир[а-яіїє]*|комнат[а-я]*|кімнат[а-яіїє]*|помещени[а-я]*|приміщен[а-яіїє]*|стен[а-я]*|стін[а-яіїє]*|двер[а-яіїє]*|вік[нна-яіїє]*|окон|окна|потол[а-я]*|стел[яюі]|фасад[а-я]*|интерьер[а-я]*|інтер['’]?єр[а-яіїє]*|экстерьер[а-я]*|екстер['’]?єр[а-яіїє]*`);
const DESIGN = words(String.raw`plans?|layouts?|design(?:s|ing)?|edit(?:s|ing)?|modify|update|move|add|remove|renovat(?:e|ion)|remodel(?:ing)?|finish(?:es|ing)?|lighting|materials?|план[а-яіїє]*|проект[а-я]*|проєкт[а-яіїє]*|дизайн[а-яіїє]*|отделк[а-я]*|оздоблен[а-яіїє]*|ремонт[а-яіїє]*|освещени[а-я]*|освітлен[а-яіїє]*|материал[а-я]*|матеріал[а-яіїє]*|измен[а-я]*|поменя[а-я]*|змін[а-яіїє]*|перенес[а-яіїє]*|перемести[а-я]*|добав[а-я]*|дод[а-яіїє]*|убери|прибери|расстав[а-я]*|розміст[а-яіїє]*`);
const SECURITY = words(String.raw`cctv|nas|nvr|surveillance|access\s+control|security\s+(?:design|systems?|plans?|cameras?)|(?:camera|cameras)\s+(?:placement|layout|coverage)|(?:place|install)\s+(?:the\s+)?(?:security\s+)?cameras?|видеонаблюдени[а-я]*|відеоспостережен[а-яіїє]*|скуд|контрол[ьяю]?\s+(?:доступа|доступу)|(?:расстановк[а-я]*|размещени[а-я]*|розміщен[а-яіїє]*|установк[а-я]*|встановлен[а-яіїє]*)\s+(?:камер[а-я]*|кабель[а-яіїє]*|кабел[а-яіїє]*)|камер[а-я]*\s+(?:наблюдения|спостереження)|(?:cable|cabling|network|wi[\s-]?fi)\s+(?:plans?|design|layouts?|coverage)|(?:план|схема|проект|проєкт)\s+(?:кабел[а-яіїє]*|камер[а-я]*|мереж[а-яіїє]*|сет[а-я]*|wi[\s-]?fi)`);

// These qualify weak words such as "plan", "project", "render", and short
// follow-ups. A real architectural/security topic or explicit invocation wins.
const OTHER_TOPIC = words(String.raw`math(?:s|ematics)?|calculate|equations?|algebra|anatomy|anatomical|sagittal|recipes?|cook(?:ing)?|dinner|weather|forecast|vacation|holiday|travel|workouts?|diet|study|studying|exams?|business\s+plan|lesson\s+plan|react|javascript|python|browser|css|математик[а-я]*|посчитай|вычисли|порахуй|обчисли|уравнени[а-я]*|рівнянн[а-яіїє]*|анатоми[а-я]*|анатомі[а-яіїє]*|рецепт[а-яіїє]*|готовить|приготов[а-я]*|пригот[а-яіїє]*|борщ|погод[а-яіїє]*|прогноз|отпуск[а-я]*|відпуст[а-яіїє]*|подорож[а-яіїє]*|трениров[а-я]*|тренуван[а-яіїє]*|диет[а-я]*|дієт[а-яіїє]*|учеб[а-я]*|навчан[а-яіїє]*|экзамен[а-я]*|іспит[а-яіїє]*`);
const NEW_PROJECT = words(String.raw`new\s+(?:plan|project)|нов(?:ый|ий|ая|а|ое|е|ую|у)\s+(?:план|проект|проєкт)`);
const PROPOSAL = words(String.raw`project\s+proposal|design\s+proposal|проектн(?:ое|ого|ые|ая)\s+предложени[еяй]|про[еє]ктн(?:а|у|ої|і)\s+пропозиц[іи][яюїі]`);
const PLAN_EDIT = words(String.raw`(?:edit|modify|update|change|redraw)\s+(?:(?:the|this|my|a)\s+)?(?:plan|layout)|(?:измен[а-я]*|редактир[а-я]*|отредактир[а-я]*|передел[а-я]*|змін[а-яіїє]*|редаг[а-яіїє]*|перероб[а-яіїє]*)\s+(?:(?:этот|цей|мій|мой)\s+)?план`);
const DELIVERABLE = words(String.raw`pdf|пдф|renders?|rendering|рендер(?:а|ы|и|ів|ов|у|ом|е|инг|инга|ингу|ингом|инге)?|(?:2d|3d)\s+(?:plans?|models?|план[а-яіїє]*|модел[а-яіїє]*)|(?:6\s*[xх×]?\s*[aа]2)`);
const PHOTO = words(String.raw`photos?|photographs?|images?|pictures?|фото|фотографи[а-я]*|фотографі[а-яіїє]*|знім[а-яіїє]*|сним[а-я]*|зображен[а-яіїє]*`);
const LOOK_AT_PHOTO = words(String.raw`(?:look\s+at|analy[sz]e|inspect|review)\s+(?:(?:the|these|this|my)\s+)?(?:photos?|photographs?|images?|pictures?)|(?:смотри|посмотри|проанализируй|дивись|подивись|проаналізуй)\s+(?:на\s+)?(?:фото|фотографи[а-я]*|фотографі[а-яіїє]*|знім[а-яіїє]*)`);
const LAUNCH = /^(?:ну[\s,]+)?(?:что[\s,]+)?погнали[\s.!?]*$/u;

const ACK = String.raw`yes|yeah|yep|ok|okay|sure|да|так|ага|добре|хорошо|ок|окей`;
const FOLLOW_UP = new RegExp(String.raw`^(?:(?:${ACK})[\s,!]+)?(?:${ACK}|continue|go on|next|do it|make(?: it)?|change(?: it)?|продолж(?:ай|и|им)|продовж(?:уй|имо)|дальше|далі|давай|делай|роби|сделай|зроби|измени|поменяй|зміни|сюда|тут|here|there|(?:make it|сделай|зроби) (?:bigger|smaller|larger|больше|меньше|більше|менше)|(?:move|change|remove) (?:this|that|it)|(?:перемести|убери|прибери|зміни) (?:это|це))$`, "u");
const COORDINATE_EDIT = /^(?:(?:change|move|update|set|измени|поменяй|зміни|змінити|перенеси)\s+)(?:(?:the|these|ці|эти)\s+)?(?:coords?|coordinates?|координат[ыиу])(?:\s*(?:to|на|до|:|=)\s*[-+\d\s.,;():=xyхоу]+)?$/u;
const COORDINATES = /^(?:[xyхоу]\s*[:=]\s*-?\d+(?:\.\d+)?[\s,;]*){1,3}$|^\(?\s*-?\d+(?:\.\d+)?\s*[,;]\s*-?\d+(?:\.\d+)?\s*\)?$/u;

function isFollowUp(text) {
  if (!text || text.length > 80 || text.split(/\s+/u).length > 12) return false;
  const command = text.replace(/[.!?]+$/u, "").trim();
  return FOLLOW_UP.test(command) || COORDINATE_EDIT.test(command) || COORDINATES.test(command);
}

/** Route only the current message and its observations, not conversation history. */
export function routeIntent({ text = "", observations = [], previousMode = "general" } = {}) {
  const current = normalize(text);
  const urls = current.match(URL) || [];
  const message = current.replace(URL, " ").replace(FILENAME, " ").replace(/\s+/gu, " ").trim();
  const grace = (reason) => ({ mode: "grace", reason });

  if (MENTION.test(message) || BRAND.test(message)) return grace("explicit-grace");
  if (Array.isArray(observations) && observations.some(isArchitecturalObservation)) return grace("plan-observation");
  if (ARCHITECTURE.test(message) || SECURITY.test(message) || (BUILDING.test(message) && DESIGN.test(message))) {
    return grace("design-topic");
  }
  if (!OTHER_TOPIC.test(message)) {
    if (NEW_PROJECT.test(message) || PROPOSAL.test(message) || LAUNCH.test(message)) return grace("project-request");
    if (PLAN_EDIT.test(message) || DELIVERABLE.test(message)) return grace("design-request");
    if ((urls.length && PHOTO.test(message)) || LOOK_AT_PHOTO.test(message)) return grace("photo-request");
    // Do not let a filename or URL disappear and turn an unrelated request into
    // "yes"/"make it". Carry-over must match the entire current message.
    if (previousMode === "grace" && isFollowUp(current)) return grace("grace-follow-up");
  }
  return { mode: "general", reason: "no-grace-intent" };
}
