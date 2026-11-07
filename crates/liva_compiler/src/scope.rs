//! Lexical symbols shared by expression checking and editor analysis.
use crate::{builtins, expression::Type};
use liva_syntax::Range;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy)]
pub enum SymbolKind {
    Value(Type),
    Function(&'static builtins::Function),
    Pending,
}

#[derive(Debug, Clone)]
pub struct Symbol {
    pub kind: SymbolKind,
    pub declaration: Option<Range>,
    pub reserved: bool,
}

impl Symbol {
    pub fn value_type(&self) -> Option<Type> {
        match self.kind {
            SymbolKind::Value(value_type) => Some(value_type),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Scope {
    symbols: BTreeMap<String, Symbol>,
    parent: Option<Box<Scope>>,
}

#[derive(Debug)]
pub struct DeclarationError {
    pub message: String,
    pub previous: Option<Range>,
}

impl Scope {
    pub fn motion() -> Self {
        let mut builtins = Self {
            symbols: BTreeMap::new(),
            parent: None,
        };

        for (name, kind, reserved) in builtins::symbols() {
            let previous = builtins.symbols.insert(
                name.into(),
                Symbol {
                    kind,
                    declaration: None,
                    reserved,
                },
            );
            assert!(previous.is_none(), "Duplicate built-in name: {name}");
        }

        Self {
            symbols: BTreeMap::new(),
            parent: Some(Box::new(builtins)),
        }
    }

    pub fn get(&self, name: &str) -> Option<&Symbol> {
        self.symbols
            .get(name)
            .or_else(|| self.parent.as_ref().and_then(|parent| parent.get(name)))
    }

    pub fn local(&self, name: &str) -> Option<&Symbol> {
        self.symbols.get(name)
    }

    pub fn is_reserved(&self, name: &str) -> bool {
        self.get(name).is_some_and(|symbol| symbol.reserved)
    }

    pub fn declare(
        &mut self,
        name: String,
        kind: SymbolKind,
        range: Range,
    ) -> Result<(), DeclarationError> {
        if self.is_reserved(&name) {
            return Err(DeclarationError {
                message: format!("{name} is a reserved built-in target"),
                previous: None,
            });
        }

        if let Some(previous) = self.local(&name) {
            return Err(DeclarationError {
                message: format!("Duplicate variable: {name}"),
                previous: previous.declaration.clone(),
            });
        }

        self.symbols.insert(
            name,
            Symbol {
                kind,
                declaration: Some(range),
                reserved: false,
            },
        );

        Ok(())
    }

    pub fn resolve(&mut self, name: &str, value_type: Type) {
        // Inference only resolves pending symbols declared in this local scope.
        let symbol = self
            .symbols
            .get_mut(name)
            .expect("type resolution requires a declared local");
        symbol.kind = SymbolKind::Value(value_type);
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &Symbol)> {
        let mut visible = BTreeMap::new();

        if let Some(parent) = &self.parent {
            visible.extend(parent.iter());
        }

        visible.extend(
            self.symbols
                .iter()
                .map(|(name, symbol)| (name.as_str(), symbol)),
        );
        visible.into_iter()
    }
}
