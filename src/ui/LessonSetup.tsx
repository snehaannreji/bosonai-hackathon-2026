import { useState } from "react";
import { CHARACTER_PRESETS, getCharacter, type CharacterId } from "../state/characters";
import type { LearnerSettings } from "../state/learnerSettings";
import { learnerSettingLabel } from "../state/learnerSettings";

export function LessonSetup({ topic, onTopic, characterId, onCharacter, settings, onSettings, sourceMaterialName, onSourceMaterial, disabled, preparing, onStart }: { topic: string; onTopic: (value: string) => void; characterId: CharacterId; onCharacter: (value: CharacterId) => void; settings: LearnerSettings; onSettings: (value: LearnerSettings) => void; sourceMaterialName: string; onSourceMaterial: (name: string, text: string) => void; disabled: boolean; preparing: boolean; onStart: () => void }) {
  const [sourceError, setSourceError] = useState("");
  const character = getCharacter(characterId);
  return <section className="lesson-setup" aria-label="Choose a lesson topic">
    <div className="character-picker">
      <label htmlFor="classroom-character">Who would you like to teach?</label>
      <select id="classroom-character" value={characterId} onChange={event => onCharacter(event.target.value as CharacterId)} disabled={disabled}>
        {CHARACTER_PRESETS.map(preset => <option value={preset.id} key={preset.id}>{preset.name}</option>)}
      </select>
      <span>{character.description}</span>
    </div>
    <form onSubmit={event => { event.preventDefault(); if (!disabled) onStart(); }}>
      <label htmlFor="lesson-topic">What would you like to teach {character.name}?</label>
      <input id="lesson-topic" value={topic} onChange={event => onTopic(event.target.value)} disabled={disabled} maxLength={160} placeholder="Any topic — photosynthesis, jazz improvisation, your favorite recipe…" aria-describedby="topic-help" autoComplete="off" />
    </form>
    <div className="learner-tuning" aria-label="Tune the AI learner">
      <label htmlFor="knowledge-level">How much should the AI know? <strong>{settings.knowledgeLevel}% · {learnerSettingLabel(settings.knowledgeLevel, "Beginner", "Knowledgeable")}</strong></label>
      <input id="knowledge-level" type="range" min="0" max="100" step="5" value={settings.knowledgeLevel} onChange={event => onSettings({ ...settings, knowledgeLevel: Number(event.target.value) })} aria-valuetext={`${settings.knowledgeLevel} percent, ${learnerSettingLabel(settings.knowledgeLevel, "beginner", "knowledgeable")}`} />
      <div className="slider-scale"><span>Beginner</span><span>Knowledgeable</span></div>
      <label htmlFor="feedback-directness">How direct should feedback be? <strong>{settings.feedbackDirectness}% · {learnerSettingLabel(settings.feedbackDirectness, "Gentle", characterId === "alex" ? "Aggressive coach" : "Direct")}</strong></label>
      <input id="feedback-directness" type="range" min="0" max="100" step="5" value={settings.feedbackDirectness} onChange={event => onSettings({ ...settings, feedbackDirectness: Number(event.target.value) })} aria-valuetext={`${settings.feedbackDirectness} percent, ${learnerSettingLabel(settings.feedbackDirectness, "gentle", characterId === "alex" ? "aggressive coach" : "direct")}`} />
      <div className="slider-scale"><span>Gentle</span><span>{characterId === "alex" ? "Forceful, aggressive coach" : "Clear and direct"}</span></div>
    </div>
    <div className="source-material">
      <label htmlFor="source-material">Optional source material <span>(.txt or .md, up to 20 KB)</span></label>
      <input id="source-material" type="file" accept=".txt,.md,text/plain,text/markdown" disabled={disabled} onChange={event => {
        const file = event.currentTarget.files?.[0];
        if (!file) return;
        if (file.size > 20 * 1024) { setSourceError("Choose a text file under 20 KB."); event.currentTarget.value = ""; return; }
        void file.text().then(text => { setSourceError(""); onSourceMaterial(file.name, text.slice(0, 20000)); }).catch(() => setSourceError("Could not read that file. Choose a .txt or .md file."));
      }} />
      {sourceMaterialName && <p className="source-loaded">Using {sourceMaterialName} as reference material. <button type="button" disabled={disabled} onClick={() => onSourceMaterial("", "")}>Remove</button></p>}
      <p className="source-help">The AI will use this as reference and say when it does not contain an answer.</p>
      {sourceError && <p className="source-error" role="alert">{sourceError}</p>}
    </div>
    <div className="topic-help-row"><p id="topic-help">{preparing ? `Preparing ${character.name}’s questions and learning map…` : "Choose a topic, start a lesson, and explain it in your own words."}</p><div className="topic-examples">{["Photosynthesis", "French past tense", "Gradient descent"].map(example => <button type="button" key={example} disabled={disabled} onClick={() => onTopic(example)}>{example}</button>)}</div></div>
    <span className="visually-hidden" role="status">{preparing ? "Preparing your lesson." : ""}</span>
  </section>;
}
