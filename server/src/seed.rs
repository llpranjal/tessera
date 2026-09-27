//! A welcome board created on first run, so the file browser is never empty.

use crate::doc::{Doc, Op};
use serde_json::{json, Value};

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

pub fn welcome() -> Doc {
    let mut nodes: Vec<Value> = vec![
        json!({"type":"text","name":"Title","x":80,"y":72,"w":760,"h":68,"text":"Welcome to Tessera","fontSize":60,"fontWeight":700,"fill":"#161A23"}),
        json!({"type":"path","name":"Underline","x":84,"y":146,"w":520,"h":22,"stroke":"#2B3BEA","strokeWidth":6,
               "points":[[0,0.6],[0.12,0.3],[0.25,0.7],[0.4,0.35],[0.55,0.75],[0.7,0.3],[0.85,0.65],[1,0.4]]}),
        json!({"type":"text","name":"Intro","x":80,"y":196,"w":640,"h":60,"text":"A multiplayer design canvas. Open this file in a second window and watch shapes, cursors, and selections sync in real time.","fontSize":20,"fontWeight":450,"fill":"#5B6272"}),
    ];

    let tiles = [
        ("rect", "#2B3BEA"),
        ("ellipse", "#F2A516"),
        ("rect", "#E8457A"),
        ("rect", "#12A383"),
        ("rect", "#161A23"),
        ("ellipse", "#0FA3D1"),
        ("ellipse", "#8A4DEB"),
        ("rect", "#F2A516"),
        ("rect", "#2B3BEA"),
    ];
    for (i, (kind, fill)) in tiles.iter().enumerate() {
        let (col, row) = ((i % 3) as i64, (i / 3) as i64);
        nodes.push(json!({"type":kind,"name":format!("Tile {}", i + 1),"x":860 + col * 108,"y":72 + row * 108,
                          "w":96,"h":96,"radius":18,"fill":fill}));
    }

    let cards = [
        (
            "Draw",
            "Pick a tool from the toolbar, or press R, O, T or P, then drag on the canvas.",
        ),
        (
            "Collaborate",
            "Edits go to a Rust server that orders them and fans them out to everyone in the file.",
        ),
        (
            "Undo",
            "Cmd+Z undoes your own changes and leaves your teammates' work alone.",
        ),
    ];
    for (i, (title, body)) in cards.iter().enumerate() {
        let x = 80 + i as i64 * 300;
        nodes.push(json!({"type":"rect","name":format!("{title} card"),"x":x,"y":440,"w":276,"h":180,"radius":20,
                          "fill":"#FFFFFF","stroke":"#D8DCE5","strokeWidth":1.5}));
        nodes.push(json!({"type":"text","name":format!("{title} heading"),"x":x + 24,"y":464,"w":228,"h":30,
                          "text":title,"fontSize":24,"fontWeight":650,"fill":"#161A23"}));
        nodes.push(
            json!({"type":"text","name":format!("{title} body"),"x":x + 24,"y":506,"w":228,"h":90,
                          "text":body,"fontSize":16,"fontWeight":450,"fill":"#5B6272"}),
        );
    }

    let ops: Vec<Op> = nodes
        .into_iter()
        .enumerate()
        .map(|(i, mut v)| {
            // Fractional index keys: "a1", "a2", ... never end in '0'.
            v["index"] = json!(format!("a{}", DIGITS[i + 1] as char));
            Op::Create {
                id: format!("seed-{i}"),
                props: v.as_object().unwrap().clone(),
            }
        })
        .collect();
    let mut doc = Doc::default();
    doc.validate(&ops).expect("seed is valid");
    doc.apply(&ops);
    doc
}
