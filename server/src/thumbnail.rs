//! Server-side SVG thumbnails for the file browser. The dashboard never has to
//! download a whole document to draw its preview.

use crate::doc::Props;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt::Write;

const PAD: f64 = 40.0;

fn num(p: &Props, k: &str, default: f64) -> f64 {
    p.get(k)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(default)
}

fn text<'a>(p: &'a Props, k: &str) -> Option<&'a str> {
    p.get(k).and_then(Value::as_str)
}

/// Only allow simple color literals through, so user data can't break out of
/// an attribute.
fn color(p: &Props, k: &str, default: &'static str) -> String {
    match text(p, k) {
        Some(c)
            if c.len() <= 32
                && c.chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "#(),. %".contains(ch)) =>
        {
            c.to_string()
        }
        _ => default.to_string(),
    }
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Nodes in paint order: fractional `index` ascending, id as a tiebreak.
pub fn paint_order(nodes: &BTreeMap<String, Props>) -> Vec<(&String, &Props)> {
    let mut v: Vec<_> = nodes.iter().collect();
    v.sort_by(|(ia, a), (ib, b)| {
        let ka = text(a, "index").unwrap_or("");
        let kb = text(b, "index").unwrap_or("");
        ka.cmp(kb).then_with(|| ia.cmp(ib))
    });
    v
}

pub fn render(nodes: &BTreeMap<String, Props>) -> String {
    let mut body = String::new();
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);

    for (_, p) in paint_order(nodes) {
        let (x, y) = (num(p, "x", 0.0), num(p, "y", 0.0));
        let (w, h) = (num(p, "w", 0.0).max(1.0), num(p, "h", 0.0).max(1.0));
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x + w);
        y1 = y1.max(y + h);

        let fill = color(p, "fill", "#D8DCE5");
        let stroke = color(p, "stroke", "none");
        let sw = num(p, "strokeWidth", 0.0);
        let opacity = num(p, "opacity", 1.0).clamp(0.0, 1.0);
        let common = format!(r#"opacity="{opacity}" stroke="{stroke}" stroke-width="{sw}""#);

        match text(p, "type").unwrap_or("rect") {
            "ellipse" => {
                let _ = write!(
                    body,
                    r#"<ellipse cx="{}" cy="{}" rx="{}" ry="{}" fill="{fill}" {common}/>"#,
                    x + w / 2.0,
                    y + h / 2.0,
                    w / 2.0,
                    h / 2.0
                );
            }
            "text" => {
                let size = num(p, "fontSize", 16.0).max(1.0);
                let per_line = ((w / (size * 0.55)).floor() as usize).max(1);
                let mut line_no = 0usize;
                let mut lines = String::new();
                for para in text(p, "text").unwrap_or("").split('\n') {
                    for chunk in wrap(para, per_line) {
                        let _ = write!(
                            lines,
                            r#"<tspan x="{x}" y="{}">{}</tspan>"#,
                            y + size * (line_no as f64 + 1.0),
                            escape(&chunk)
                        );
                        line_no += 1;
                    }
                }
                let weight = num(p, "fontWeight", 500.0);
                let _ = write!(
                    body,
                    r#"<text font-family="Instrument Sans, system-ui, sans-serif" font-size="{size}" font-weight="{weight}" fill="{fill}" opacity="{opacity}">{lines}</text>"#
                );
            }
            "path" => {
                let pts = p.get("points").and_then(Value::as_array);
                let mut d = String::new();
                for (i, pt) in pts.into_iter().flatten().enumerate() {
                    let Some([px, py]) = pt.as_array().map(|a| {
                        [
                            a.first().and_then(Value::as_f64),
                            a.get(1).and_then(Value::as_f64),
                        ]
                    }) else {
                        continue;
                    };
                    let (Some(px), Some(py)) = (px, py) else {
                        continue;
                    };
                    let _ = write!(
                        d,
                        "{}{:.1} {:.1} ",
                        if i == 0 { "M" } else { "L" },
                        x + px * w,
                        y + py * h
                    );
                }
                let stroke = color(p, "stroke", "#161A23");
                let sw = num(p, "strokeWidth", 4.0);
                let _ = write!(
                    body,
                    r#"<path d="{}" fill="none" stroke="{stroke}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round" opacity="{opacity}"/>"#,
                    d.trim_end()
                );
            }
            _ => {
                let r = num(p, "radius", 0.0).clamp(0.0, w.min(h) / 2.0);
                let _ = write!(
                    body,
                    r#"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" {common}/>"#
                );
            }
        }
    }

    let view = if nodes.is_empty() {
        "0 0 320 200".to_string()
    } else {
        format!(
            "{} {} {} {}",
            x0 - PAD,
            y0 - PAD,
            x1 - x0 + PAD * 2.0,
            y1 - y0 + PAD * 2.0
        )
    };
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" preserveAspectRatio="xMidYMid meet">{body}</svg>"#
    )
}

fn wrap(s: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for word in s.split(' ') {
        if !cur.is_empty() && cur.chars().count() + 1 + word.chars().count() > width {
            lines.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    lines.push(cur);
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(v: Value) -> BTreeMap<String, Props> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn empty_doc_renders_placeholder_viewbox() {
        assert!(render(&BTreeMap::new()).contains(r#"viewBox="0 0 320 200""#));
    }

    #[test]
    fn renders_shapes_in_index_order_with_padded_bounds() {
        let svg = render(&doc(json!({
            "top": {"type":"ellipse","x":0,"y":0,"w":100,"h":50,"fill":"#E8457A","index":"b"},
            "bottom": {"type":"rect","x":100,"y":100,"w":100,"h":100,"fill":"#2B3BEA","index":"a"}
        })));
        assert!(svg.contains(r#"viewBox="-40 -40 280 280""#));
        let rect = svg.find("<rect").unwrap();
        let ellipse = svg.find("<ellipse").unwrap();
        assert!(rect < ellipse, "lower index paints first");
    }

    #[test]
    fn escapes_text_and_rejects_hostile_colors() {
        let svg = render(&doc(json!({
            "t": {"type":"text","x":0,"y":0,"w":400,"h":20,"text":"<script>&","fill":"\"/><script>"}
        })));
        assert!(svg.contains("&lt;script&gt;&amp;"));
        assert!(!svg.contains("<script>"));
        assert!(svg.contains(r##"fill="#D8DCE5""##));
    }

    #[test]
    fn scales_normalized_path_points() {
        let svg = render(&doc(json!({
            "p": {"type":"path","x":10,"y":10,"w":100,"h":50,"points":[[0,0],[1,1]]}
        })));
        assert!(svg.contains(r#"d="M10.0 10.0 L110.0 60.0""#));
    }

    #[test]
    fn wraps_words() {
        assert_eq!(wrap("aa bb cc", 5), vec!["aa bb", "cc"]);
        assert_eq!(wrap("", 5), vec![""]);
    }
}
