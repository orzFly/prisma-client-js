import { DMMF } from './dmmf-types'
import { Dictionary, stringifyInputType, uniqBy } from './utils/common'

export function transformDmmf(document: DMMF.Document): DMMF.Document {
  const doc = transformOrderInputTypes(transformWhereInputTypes(document))
  return {
    datamodel: doc.datamodel,
    mappings: doc.mappings,
    schema: {
      enums: doc.schema.enums,
      queries: doc.schema.queries,
      mutations: doc.schema.mutations,
      outputTypes: filterOutputTypes(doc.schema.outputTypes),
      inputTypes: filterInputTypes(doc.schema.inputTypes),
    },
  }
}

function filterInputTypes(types: DMMF.InputType[]): DMMF.InputType[] {
  return uniqBy(types, o => o.name).filter(o => !o.name.includes('Subscription') && o.name !== 'MutationType')
}

function filterOutputTypes(types: DMMF.OutputType[]): DMMF.OutputType[] {
  return uniqBy(types, o => o.name).filter(o => {
    return !o.name.endsWith('PreviousValues') && !o.name.includes('Subscription')
  })
}

function transformOrderInputTypes(document: DMMF.Document): DMMF.Document {
  const inputTypes: DMMF.InputType[] = document.schema.inputTypes
  const enums: DMMF.Enum[] = [
    {
      name: 'OrderByArg',
      values: ['asc', 'desc'],
    },
  ]
  for (const type of document.schema.enums) {
    if (!type.name.endsWith('OrderByInput')) {
      enums.push(type)
      continue
    }
    const argNames = type.values.reduce<string[]>((acc, curr) => {
      if (curr.endsWith('ASC')) {
        const index = curr.lastIndexOf('_ASC')
        acc.push(curr.slice(0, index))
      }
      return acc
    }, [])
    const inputType = {
      name: type.name,
      atLeastOne: true,
      atMostOne: true,
      isOrderType: true,
      args: argNames.map(name => ({
        name,
        type: ['OrderByArg'],
        isEnum: false,
        isList: false,
        isRelationFilter: false,
        isRequired: false,
        isScalar: true,
      })),
    }
    inputTypes.push(inputType)
  }

  return {
    datamodel: document.datamodel,
    mappings: document.mappings,
    schema: {
      ...document.schema,
      inputTypes,
      enums,
    },
  }
}

function transformWhereInputTypes(document: DMMF.Document): DMMF.Document {
  const types = document.schema.inputTypes
  const inputTypes: DMMF.InputType[] = []
  const filterTypes: Dictionary<DMMF.InputType> = {}
  for (const type of types) {
    if (!type.name.endsWith('WhereInput')) {
      inputTypes.push(type)
      continue
    }

    // lastIndexOf necessary if a type is called "WhereInput"
    const index = type.name.lastIndexOf('WhereInput')
    const modelName = type.name.slice(0, index)
    const model = document.datamodel.models.find(m => m.name === modelName)!
    if (!model) {
      inputTypes.push(type)
      continue
    }
    const whiteList = ['AND', 'OR', 'NOT']
    whiteList.push(...model.fields.filter(f => f.kind === 'relation' && !f.isList).map(f => f.name))

    const args = type.args.filter(a => whiteList.includes(a.name)).map(a => ({ ...a, isRelationFilter: true }))
    // NOTE: list scalar fields don't have where arguments!
    args.unshift(
      ...model.fields
        // filter out scalar lists as Prisma doesn't have filters for them
        // also filter out relation non-lists, as we don't need to transform them
        .filter(f => (f.kind === 'relation' ? f.isList : !f.isList))
        .map(f => {
          if (!filterTypes[getFilterName(f.type, f.isRequired || f.kind === 'relation')]) {
            filterTypes[getFilterName(f.type, f.isRequired || f.kind === 'relation')] = makeFilterType(
              f.type,
              f.isRequired,
              f.kind !== 'relation',
            )
          }

          const typeList: any[] = []
          if (f.kind !== 'relation') {
            typeList.push(f.type)
          }
          typeList.push(getFilterName(f.type, f.isRequired || f.kind === 'relation'))

          // for optional scalars you can directly provide null
          if (!f.isRequired && f.kind !== 'relation') {
            typeList.push('null')
          }

          return {
            name: f.name,
            type: typeList,
            isScalar: false,
            isRequired: false,
            isEnum: false,
            isList: false,
            isRelationFilter: false,
          }
        }),
    )
    const newType: DMMF.InputType = {
      name: type.name,
      args,
      isWhereType: true,
      atLeastOne: true,
    }
    inputTypes.push(newType)
  }
  const scalarFilters = Object.values(filterTypes)
  inputTypes.push(...scalarFilters)

  return {
    datamodel: document.datamodel,
    mappings: document.mappings,
    schema: {
      ...document.schema,
      inputTypes,
    },
  }
}

function getFilterName(type: string, isRequired: boolean) {
  return `${isRequired ? '' : 'Nullable'}${type}Filter`
}

function getWhereInputName(type: string) {
  return `${type}WhereInput`
}

function makeFilterType(type: string, isRequired: boolean, isScalar: boolean): DMMF.InputType {
  return {
    name: getFilterName(type, isRequired || !isScalar),
    args: isScalar ? getScalarFilterArgs(type, isRequired) : getRelationFilterArgs(type),
    atLeastOne: true,
  }
}

function getRelationFilterArgs(type: string): DMMF.SchemaArg[] {
  return getScalarArgs(['every', 'some', 'none'], [getWhereInputName(type)])
}

function getScalarFilterArgs(type: string, isRequired: boolean, isEnum = false): DMMF.SchemaArg[] {
  if (isEnum) {
    return [...getBaseFilters(type, isRequired), ...getInclusionFilters(type)]
  }
  switch (type) {
    case 'String':
    case 'ID':
    case 'UUID':
      return [
        ...getBaseFilters(type, isRequired),
        ...getInclusionFilters(type),
        ...getAlphanumericFilters(type),
        ...getStringFilters(type),
      ]
    case 'Int':
    case 'Float':
    case 'DateTime':
      return [...getBaseFilters(type, isRequired), ...getInclusionFilters(type), ...getAlphanumericFilters(type)]
    case 'Boolean':
      return [...getBaseFilters(type, isRequired)]
  }

  return []
}

function getBaseFilters(type: string, isRequired: boolean): DMMF.SchemaArg[] {
  const filterName = getFilterName(type, isRequired)
  // TODO: reintroduce AND, NOT, OR
  const nullArray = isRequired ? [] : ['null']
  return [
    ...getScalarArgs(['equals'], [type, ...nullArray]),
    ...getScalarArgs(
      ['not'],
      [type, ...nullArray, filterName],
    ) /*, ...getScalarArgs(['AND', 'NOT', 'OR'], [filterName])*/,
  ]
}

function getStringFilters(type: string): DMMF.SchemaArg[] {
  return getScalarArgs(['contains', 'startsWith', 'endsWith'], [type])
}

function getAlphanumericFilters(type: string): DMMF.SchemaArg[] {
  return getScalarArgs(['lt', 'lte', 'gt', 'gte'], [type])
}

function getInclusionFilters(type: string): DMMF.SchemaArg[] {
  return getScalarArgs(['in', 'notIn'], [type], true)
}

function getScalarArgs(names: string[], type: string[], isList = false): DMMF.SchemaArg[] {
  return names.map(name => getScalarArg(name, type, isList))
}

function getScalarArg(name: string, type: string[], isList): DMMF.SchemaArg {
  return {
    name,
    isEnum: false,
    isList,
    isRequired: false,
    isScalar: true,
    type,
  }
}