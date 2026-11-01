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
node!(State, |n: &SyntaxNode| block_depth(n) == 1
    && keyword(n, "state"));
node!(Transition, |n: &SyntaxNode| block_depth(n) == 1
    && (keyword(n, "transition")
        || keyword(n, "enter")
        || keyword(n, "leave")));
node!(Target, |n: &SyntaxNode| n.kind() == Kind::Block
    && block_depth(n) == 2);
node!(PropertyBlock, |n: &SyntaxNode| n.kind() == Kind::Block
    && block_depth(n) == 3);
node!(Keyframe, |n: &SyntaxNode| n.kind() == Kind::Declaration
    && block_depth(n) == 4
    && n.child::<Header>()
        .is_some_and(|h| h.semantic_text().ends_with('%')));
node!(Property, |n: &SyntaxNode| n.kind() == Kind::Declaration);
node!(Event, |n: &SyntaxNode| n.kind() == Kind::Event);
node!(LetBinding, |n: &SyntaxNode| n.kind() == Kind::Let);
node!(Parameter, |n: &SyntaxNode| n.kind() == Kind::Parameter);
node!(Parameters, |n: &SyntaxNode| n.kind() == Kind::Parameters);
node!(TypeReference, |n: &SyntaxNode| n.kind()
    == Kind::TypeReference);
node!(Header, |n: &SyntaxNode| n.kind() == Kind::Header);
node!(Value, |n: &SyntaxNode| n.kind() == Kind::Value);
node!(Condition, |n: &SyntaxNode| n.kind() == Kind::Condition);
node!(Interpolation, |n: &SyntaxNode| n.kind()
    == Kind::Interpolation);

macro_rules! implement {
    ($trait:ident: $($name:ident),+ $(,)?) => { $(impl $trait for $name {})+ };
}
implement!(HasHeader: Block, Motion, State, Transition, Target, PropertyBlock, Keyframe, Property, LetBinding, Parameter, Event);
implement!(HasValue: Property, LetBinding, Keyframe);
implement!(HasItems: Document, Block, Motion, State, Transition, Target, PropertyBlock);

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

impl State {
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

impl Transition {
    pub fn targets(&self) -> impl Iterator<Item = Target> {
        self.children()
    }
}

impl Target {
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

impl Interpolation {
    pub fn expression(&self) -> Option<expression::Expr> {
        self.child()
    }
}

#[derive(Debug, Clone)]
pub enum MotionItem {
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
            if let Some(state) =
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
            ["transition", from, "->", to] => Some(TransitionSelector::Directional {
                from: (*from).into(),
                to: (*to).into(),
            }),
            _ => None,
        }
    }
}
