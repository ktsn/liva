use super::{AstNode, HasHeader, HasItems, HasValue, expression};
use crate::{Kind, SyntaxNode};

macro_rules! node {
    ($name:ident, $test:expr) => {
        #[derive(Debug, Clone)]
        pub struct $name(SyntaxNode);

        impl AstNode for $name {
            fn cast(node: SyntaxNode) -> Option<Self> {
                ($test)(&node).then_some(Self(node))
            }
            fn syntax(&self) -> &SyntaxNode {
                &self.0
            }
        }
    };
}

fn block_depth(node: &SyntaxNode) -> usize {
    node.ancestors()
        .skip(1)
        .filter(|node| node.kind() == Kind::Block)
        .count()
}

fn keyword(node: &SyntaxNode, word: &str) -> bool {
    node.kind() == Kind::Block
        && node
            .children()
            .find(|node| node.kind() == Kind::Header)
            .is_some_and(|header| header.semantic_text().split_whitespace().next() == Some(word))
}

node!(Document, |n: &SyntaxNode| n.kind() == Kind::Document);
node!(Block, |n: &SyntaxNode| n.kind() == Kind::Block);
// Top-level blocks retain the Motion view even when their header is incomplete.
node!(Motion, |n: &SyntaxNode| n.kind() == Kind::Block
    && n.parent().is_some_and(|p| p.kind() == Kind::Document));
node!(Layer, |n: &SyntaxNode| block_depth(n) == 1
    && keyword(n, "layer"));
node!(State, |n: &SyntaxNode| keyword(n, "state")
    && (block_depth(n) == 1
        || n.parent()
            .is_some_and(|parent| Layer::cast(parent).is_some())));
// A bare `on { ... }` remains a named target; an event header has a parsed condition.
node!(OnBlock, |n: &SyntaxNode| keyword(n, "on")
    && n.child::<Header>().is_some_and(|header| header
        .child::<Condition>()
        .is_some()));
node!(Transition, |n: &SyntaxNode| (block_depth(n) == 1
    || n.parent().is_some_and(|parent| Layer::cast(
        parent.clone()
    )
    .is_some()
        || OnBlock::cast(parent).is_some()))
    && (keyword(n, "transition")
        || keyword(n, "enter")
        || keyword(n, "leave")));
node!(Target, |n: &SyntaxNode| n.kind() == Kind::Block
    && PropertyBlock::cast(n.clone()).is_none()
    && State::cast(n.clone()).is_none()
    && OnBlock::cast(n.clone()).is_none()
    && Transition::cast(n.clone()).is_none()
    && n.parent().is_some_and(|parent| State::cast(
        parent.clone()
    )
    .is_some()
        || Layer::cast(parent.clone()).is_some()
        || Transition::cast(parent).is_some()));
node!(PropertyBlock, |n: &SyntaxNode| n.kind() == Kind::Block
    && n.children_with_tokens().any(|element| element
        .as_token()
        .is_some_and(|token| token.text() == "~>")));
node!(Keyframe, |n: &SyntaxNode| n.kind() == Kind::Declaration
    && n.parent()
        .is_some_and(
            |parent| PropertyBlock::cast(parent).is_some()
        )
    && n.child::<Header>()
        .is_some_and(|h| h.semantic_text().ends_with('%')));
node!(Property, |n: &SyntaxNode| n.kind() == Kind::Declaration);
// Reserved declarations retain their typed view even when their value is malformed.
node!(LayoutDeclaration, |n: &SyntaxNode| n.kind()
    == Kind::Declaration
    && n.child::<Header>()
        .is_some_and(|header| header.semantic_text() == "$layout"));
node!(Event, |n: &SyntaxNode| n.kind() == Kind::Event);
node!(LetBinding, |n: &SyntaxNode| n.kind() == Kind::Let);
node!(Parameter, |n: &SyntaxNode| n.kind() == Kind::Parameter);
node!(Parameters, |n: &SyntaxNode| n.kind() == Kind::Parameters);
node!(TypeReference, |n: &SyntaxNode| n.kind()
    == Kind::TypeReference);
node!(Header, |n: &SyntaxNode| n.kind() == Kind::Header);
node!(Value, |n: &SyntaxNode| n.kind() == Kind::Value);
node!(Condition, |n: &SyntaxNode| n.kind() == Kind::Condition);
node!(Decorator, |n: &SyntaxNode| n.kind() == Kind::Decorator);
node!(Interpolation, |n: &SyntaxNode| n.kind()
    == Kind::Interpolation);

macro_rules! implement {
    ($trait:ident: $($name:ident),+ $(,)?) => { $(impl $trait for $name {})+ };
}
implement!(HasHeader: Block, Motion, Layer, State, Transition, Target, PropertyBlock, Keyframe, Property, LayoutDeclaration, LetBinding, Parameter, Event, OnBlock);
implement!(HasValue: Property, LayoutDeclaration, LetBinding, Keyframe);
implement!(HasItems: Document, Block, Motion, Layer, State, Transition, Target, PropertyBlock, OnBlock);

impl Document {
    pub fn motions(&self) -> impl Iterator<Item = Motion> {
        self.children()
    }
}

impl Motion {
    pub fn name(&self) -> Option<String> {
        let header = self.header_node()?;
        let mut before = String::new();
        let mut after = String::new();
        let mut parameter_lists = 0;

        for element in header.syntax().children_with_tokens() {
            match element {
                rowan::NodeOrToken::Node(node) if node.kind() == Kind::Parameters => {
                    parameter_lists += 1;
                }
                rowan::NodeOrToken::Token(token) => {
                    let spelling = if token.kind() == Kind::Trivia
                        && (token.text().starts_with("/*") || token.text().starts_with("//"))
                    {
                        " "
                    } else {
                        token.text()
                    };
                    if parameter_lists == 0 {
                        before.push_str(spelling);
                    } else {
                        after.push_str(spelling);
                    }
                }
                _ => return None,
            }
        }

        let text = before.trim();
        let words: Vec<_> = text.split_whitespace().collect();
        match words.as_slice() {
            ["motion", name]
                if crate::is_name(name) && parameter_lists <= 1 && after.trim().is_empty() =>
            {
                Some((*name).into())
            }
            _ => None,
        }
    }

    pub fn parameters(&self) -> impl Iterator<Item = Parameter> {
        self.header_node()
            .and_then(|header| header.child::<Parameters>())
            .into_iter()
            .flat_map(|list| list.children::<Parameter>().collect::<Vec<_>>())
    }

    pub fn layers(&self) -> impl Iterator<Item = Layer> {
        self.children()
    }

    pub fn states(&self) -> impl Iterator<Item = State> {
        self.children()
    }

    /// All animation blocks, including enter and leave declarations.
    pub fn transitions(&self) -> impl Iterator<Item = Transition> {
        self.children()
    }

    pub fn enters(&self) -> impl Iterator<Item = Transition> {
        self.transitions()
            .filter(|transition| keyword(transition.syntax(), "enter"))
    }

    pub fn leaves(&self) -> impl Iterator<Item = Transition> {
        self.transitions()
            .filter(|transition| keyword(transition.syntax(), "leave"))
    }

    pub fn events(&self) -> impl Iterator<Item = Event> {
        self.children()
    }
}

impl Event {
    pub fn name(&self) -> Option<String> {
        self.header().filter(|name| crate::is_name(name))
    }

    pub fn condition(&self) -> Option<Condition> {
        self.child()
    }
}

impl Layer {
    pub fn transitions(&self) -> impl Iterator<Item = Transition> {
        self.syntax().children().flat_map(|node| {
            if let Some(transition) = Transition::cast(node.clone()) {
                vec![transition]
            } else if let Some(event) = OnBlock::cast(node) {
                event.transitions().collect()
            } else {
                vec![]
            }
        })
    }

    pub fn event_blocks(&self) -> impl Iterator<Item = OnBlock> {
        self.children()
    }

    pub fn states(&self) -> impl Iterator<Item = State> {
        self.children()
    }

    pub fn name(&self) -> Option<String> {
        self.header()?.split_whitespace().nth(1).map(str::to_owned)
    }

    pub fn condition(&self) -> Option<Condition> {
        self.header_node()?.child()
    }

    pub fn targets(&self) -> impl Iterator<Item = Target> {
        self.children()
    }
}

impl State {
    pub fn is_initial(&self) -> bool {
        self.header()
            .is_some_and(|header| header.split_whitespace().nth(2) == Some("initial"))
    }

    pub fn name(&self) -> Option<String> {
        self.header()?.split_whitespace().nth(1).map(str::to_owned)
    }

    pub fn condition(&self) -> Option<Condition> {
        self.header_node()?.child()
    }

    pub fn targets(&self) -> impl Iterator<Item = Target> {
        self.children()
    }
}

impl OnBlock {
    pub fn event_expression(&self) -> Option<expression::Expr> {
        self.header_node()?.child::<Condition>()?.expression()
    }

    pub fn transitions(&self) -> impl Iterator<Item = Transition> {
        self.children()
    }
}

impl Property {
    pub fn is_attachment(&self) -> bool {
        self.syntax()
            .children_with_tokens()
            .any(|element| element.as_token().is_some_and(|token| token.text() == ":="))
    }

    pub fn attachment(&self) -> Option<expression::Expr> {
        self.is_attachment()
            .then(|| self.value_node()?.expression())
            .flatten()
    }
}

impl Transition {
    pub fn event_block(&self) -> Option<OnBlock> {
        OnBlock::cast(self.syntax().parent()?)
    }

    pub fn condition(&self) -> Option<Condition> {
        self.header_node()?.child()
    }

    pub fn targets(&self) -> impl Iterator<Item = Target> {
        self.children()
    }
}

#[derive(Debug, Clone)]
pub enum AnimationProperty {
    Shorthand(Property),
    Keyframes(PropertyBlock),
}

/// Animation declarations directly contained by a target or implicit-self scope.
pub fn animation_properties(node: &impl AstNode) -> impl Iterator<Item = AnimationProperty> {
    node.syntax().children().filter_map(|node| {
        Property::cast(node.clone())
            .map(AnimationProperty::Shorthand)
            .or_else(|| PropertyBlock::cast(node).map(AnimationProperty::Keyframes))
    })
}

impl Target {
    /// Style/configuration declarations and explicit tracks in source order, including malformed items.
    pub fn animation_properties(&self) -> impl Iterator<Item = AnimationProperty> {
        animation_properties(self)
    }

    pub fn property_blocks(&self) -> impl Iterator<Item = PropertyBlock> {
        self.children()
    }
}

impl PropertyBlock {
    pub fn keyframes(&self) -> impl Iterator<Item = Keyframe> {
        self.children()
    }
}

impl Parameter {
    pub fn type_reference(&self) -> Option<TypeReference> {
        self.child()
    }
}

impl LetBinding {
    pub fn initializer(&self) -> Option<expression::Expr> {
        self.value_node()?.expression()
    }
}

impl Value {
    pub fn expression(&self) -> Option<expression::Expr> {
        self.child()
    }

    pub fn interpolations(&self) -> impl Iterator<Item = Interpolation> {
        self.children()
    }
}

impl Condition {
    pub fn expression(&self) -> Option<expression::Expr> {
        self.child()
    }
}

impl Decorator {
    pub fn expression_text(&self) -> String {
        self.text().strip_prefix('@').unwrap_or_default().to_owned()
    }

    pub fn expression_range(&self) -> crate::Range {
        let mut range = self.range();
        range.start += 1;
        range
    }
}

impl Interpolation {
    pub fn expression(&self) -> Option<expression::Expr> {
        self.child()
    }
}

#[derive(Debug, Clone)]
pub enum MotionItem {
    Layer(Layer),
    State(State),
    Transition(Transition),
    Invalid(Block),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransitionSelector {
    General,
    Enter,
    Leave,
    Directional { from: String, to: String },
}

impl Motion {
    pub fn items(&self) -> impl Iterator<Item = MotionItem> {
        self.blocks().map(|block| {
            if let Some(layer) =
                Layer::cast(block.syntax().clone()).filter(|layer| layer.name().is_some())
            {
                MotionItem::Layer(layer)
            } else if let Some(state) =
                State::cast(block.syntax().clone()).filter(|state| state.name().is_some())
            {
                MotionItem::State(state)
            } else if let Some(transition) = Transition::cast(block.syntax().clone()) {
                MotionItem::Transition(transition)
            } else {
                MotionItem::Invalid(block)
            }
        })
    }
}

impl Transition {
    pub fn selector(&self) -> Option<TransitionSelector> {
        let header = self.header()?;
        match header.split_whitespace().collect::<Vec<_>>().as_slice() {
            ["transition"] => Some(TransitionSelector::General),
            ["enter"] => Some(TransitionSelector::Enter),
            ["leave"] => Some(TransitionSelector::Leave),
            ["transition", from, "->", to] | ["transition", from, "->", to, "when", ..] => {
                Some(TransitionSelector::Directional {
                    from: (*from).into(),
                    to: (*to).into(),
                })
            }
            _ => None,
        }
    }
}

impl LayoutDeclaration {
    /// Raw fixed keywords before postfix timing, retaining malformed input for diagnostics.
    pub fn selection(&self) -> Option<String> {
        self.value_text()
    }

    /// Controller spelling is exposed for diagnostics; attachments are not valid selections.
    pub fn is_attachment(&self) -> bool {
        self.syntax()
            .children_with_tokens()
            .any(|element| element.as_token().is_some_and(|token| token.text() == ":="))
    }
}
